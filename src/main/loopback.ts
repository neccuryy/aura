// WASAPI loopback capture → vocal-band DSP → VAD segments.
// The native addon (native/loopback) only captures; everything else —
// mid-side extraction, bandpass, voice activity detection — happens here
// in TypeScript. Dev only (started when !app.isPackaged) until Stage 2
// turns segments into synced lyrics.

import * as path from "path";
import { VoiceIsolator, VadSegmenter, VocalSegment } from "./dsp";

interface LoopbackChunk {
	sampleRate: number;
	channels: number;
	data: Buffer;
}

interface LoopbackInstance {
	// the addon passes a single argument: an Error on failure, a chunk otherwise
	start(cb: (arg: Error | LoopbackChunk) => void): void;
	stop(): void;
}

interface LoopbackAddon {
	Loopback: new () => LoopbackInstance;
}

let instance: LoopbackInstance | null = null;
let isolator: VoiceIsolator | null = null;
let segmenter: VadSegmenter | null = null;
let midBuf: Float32Array | null = null;
let sideBuf: Float32Array | null = null;

// per-second aggregation state (observability while tuning the DSP)
let secondIndex = 0;
let mixSumSquares = 0;
let midSumSquares = 0;
let sideSumSquares = 0;
let sampleCount = 0; // frames of audio seen this second
let peak = 0;
let floor = Infinity; // running minimum of per-second mix RMS — the "silence" level
let totalFrames = 0;  // timeline position since capture start
let cpuStart: NodeJS.CpuUsage | null = null;
let cpuStartTime = 0;

// Stage 2 track clock: SMTC position samples pair the capture timeline
// with the track timeline so vocal segments can be mapped into track
// seconds (player pauses and seeks included)
interface TrackSample {
	captureT: number;
	trackT: number;
}
let captureSampleRate = 0;
let trackSamples: TrackSample[] = [];
let trackSegments: VocalSegment[] = []; // closed segments of the current track
let trackStartT = 0; // capture time when the current track began
// vocal energy envelope (effective vocal RMS per chunk) in capture time —
// feeds intra-block segment refinement in the aligner
let energySamples: { t: number; e: number }[] = [];

export function captureTime(): number {
	return captureSampleRate ? totalFrames / captureSampleRate : 0;
}

// a new track started — vocal evidence collected so far belongs to the
// previous one; call BEFORE reading segments for the new track
export function beginTrack(): void {
	trackSamples = [];
	trackSegments = [];
	energySamples = [];
	trackStartT = captureTime();
}

// SMTC position tick (500ms poll loop) — records the pairing needed to
// map capture time → track time
export function noteTrackPosition(trackT: number): void {
	if (!instance) return;
	trackSamples.push({ captureT: captureTime(), trackT });
	// bound the buffer — hours of playback still map fine via interpolation
	if (trackSamples.length > 20000) trackSamples.splice(0, 10000);
}

function slopeBetween(a: TrackSample, b: TrackSample): number {
	const dt = b.captureT - a.captureT;
	return dt > 0 ? (b.trackT - a.trackT) / dt : 0;
}

function captureToTrack(captureT: number): number {
	const s = trackSamples;
	if (s.length === 0) return 0;
	if (captureT <= s[0].captureT) {
		// before the first sample — back-extrapolate with the first slope
		const slope = s.length > 1 ? Math.max(0, slopeBetween(s[0], s[1])) : 0;
		return Math.max(0, s[0].trackT - (s[0].captureT - captureT) * slope);
	}
	for (let k = 1; k < s.length; k++) {
		if (captureT <= s[k].captureT) {
			return s[k - 1].trackT + (captureT - s[k - 1].captureT) * slopeBetween(s[k - 1], s[k]);
		}
	}
	// after the last sample — forward-extrapolate with the last slope
	const last = s[s.length - 1];
	const slope = s.length > 1 ? slopeBetween(s[s.length - 2], last) : 0;
	return last.trackT + (captureT - last.captureT) * Math.max(0, slope);
}

// vocal energy envelope of the current track in TRACK time. Samples that
// fall in paused playback (track time not advancing) are dropped — they
// would read as spurious deep dips at a single track instant.
export function getTrackEnergy(): { t: number; e: number }[] {
	if (!instance) return [];
	const out: { t: number; e: number }[] = [];
	let prevT = -1;
	for (const s of energySamples) {
		if (s.t < trackStartT) continue;
		const t = captureToTrack(s.t);
		if (t <= prevT + 0.02) continue; // paused or degenerate — skip
		out.push({ t, e: s.e });
		prevT = t;
	}
	return out;
}

// vocal segments of the current track in TRACK time, including the
// still-open segment (live alignment must see vocals in flight)
export function getTrackSegments(): { start: number; end: number }[] {
	if (!instance) return [];
	const now = captureTime();
	const closed = trackSegments.slice();
	if (segmenter && segmenter.active) {
		closed.push({ start: Math.max(segmenter.currentStart, trackStartT), end: now });
	}
	const out: { start: number; end: number }[] = [];
	for (const seg of closed) {
		const start = captureToTrack(Math.max(seg.start, trackStartT));
		const end = captureToTrack(seg.end);
		// pause-collapsed or degenerate (e.g. noise while the player was
		// paused maps to a single track instant) — useless as evidence
		if (end - start < 0.2) continue;
		out.push({ start, end });
	}
	return out;
}

function fmtSegment(s: VocalSegment): string {
	return `${s.start.toFixed(1)}s–${s.end.toFixed(1)}s (${(s.end - s.start).toFixed(1)}s)`;
}

function logSecond(channels: number) {
	if (sampleCount === 0) return;
	const mix = Math.sqrt(mixSumSquares / (sampleCount * channels));
	const mid = Math.sqrt(midSumSquares / sampleCount);
	const side = Math.sqrt(sideSumSquares / sampleCount);
	if (mix < floor) floor = mix;
	// mix-active = clearly above the quietest second we've seen — true while
	// any music plays; voice−side is the column that should contrast
	const active = mix > floor * 3 && mix > 0.001;
	const thr = segmenter ? segmenter.threshold : 0;
	const seg = segmenter ? (segmenter.active ? 1 : 0) : 0;
	console.log(
		`[loopback] t=${secondIndex}s mix=${mix.toFixed(5)} mid=${mid.toFixed(5)} side=${side.toFixed(5)} thr=${thr.toFixed(5)} seg=${seg} peak=${peak.toFixed(3)} active=${active}`
	);
	secondIndex++;
	mixSumSquares = 0;
	midSumSquares = 0;
	sideSumSquares = 0;
	sampleCount = 0;
	peak = 0;
}

export function startLoopback(): void {
	if (instance) return;
	try {
		const addon: LoopbackAddon = require(path.join(
			__dirname, "..", "..", "native", "loopback", "build", "Release", "aura_loopback.node"
		));
		instance = new addon.Loopback();
	} catch (e) {
		console.log(`[loopback] addon unavailable: ${e instanceof Error ? e.message : e}`);
		return;
	}

	secondIndex = 0;
	mixSumSquares = 0;
	midSumSquares = 0;
	sideSumSquares = 0;
	sampleCount = 0;
	peak = 0;
	floor = Infinity;
	totalFrames = 0;
	captureSampleRate = 0;
	trackSamples = [];
	trackSegments = [];
	energySamples = [];
	trackStartT = 0;
	isolator = null; // built on the first chunk (needs the real sample rate)
	segmenter = null;
	cpuStart = process.cpuUsage();
	cpuStartTime = process.uptime();

	instance.start((arg) => {
		if (arg instanceof Error) {
			console.log(`[loopback] capture error: ${arg.message}`);
			return;
		}
		const chunk = arg;
		if (!segmenter || !isolator) {
			isolator = new VoiceIsolator(chunk.sampleRate);
			segmenter = new VadSegmenter();
			captureSampleRate = chunk.sampleRate;
		}

		const samples = new Float32Array(
			chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength / 4
		);
		const frames = samples.length / chunk.channels;
		if (!midBuf || midBuf.length < frames) {
			midBuf = new Float32Array(frames);
			sideBuf = new Float32Array(frames);
		}
		// allocated together above — sideBuf is never null when midBuf isn't
		isolator.process(samples, chunk.channels, frames, midBuf, sideBuf!);

		// full-mix RMS + peak (observability column)
		for (let i = 0; i < samples.length; i++) {
			const s = samples[i];
			mixSumSquares += s * s;
			const a = Math.abs(s);
			if (a > peak) peak = a;
		}

		// bandpassed mid/side frame RMS → VAD
		let mss = 0;
		let sss = 0;
		const midArr = midBuf;
		const sideArr = sideBuf as Float32Array;
		for (let i = 0; i < frames; i++) {
			mss += midArr[i] * midArr[i];
			sss += sideArr[i] * sideArr[i];
		}
		const midRms = Math.sqrt(mss / frames);
		const sideRms = Math.sqrt(sss / frames);
		const tStart = totalFrames / chunk.sampleRate;
		totalFrames += frames;
		// effective vocal energy for the envelope (mid−side, floor 0)
		energySamples.push({ t: tStart, e: Math.max(0, midRms - sideRms) });
		if (energySamples.length > 100000) energySamples.splice(0, 50000);
		const wasActive = segmenter.active;
		const seg = segmenter.onFrame(midRms, sideRms, frames / chunk.sampleRate, tStart);
		if (!wasActive && segmenter.active) {
			console.log(`[vad] open @ ${segmenter.currentStart.toFixed(1)}s`);
		}
		if (seg) {
			console.log(`[vad] segment ${fmtSegment(seg)}`);
			trackSegments.push(seg);
		}

		midSumSquares += mss;
		sideSumSquares += sss;
		sampleCount += frames;

		// one log line per second of audio
		if (sampleCount >= chunk.sampleRate) logSecond(chunk.channels);
	});

	console.log("[loopback] started (device-wide loopback, mid+bandpass+VAD)");
}

export function stopLoopback(): void {
	if (!instance) return;
	instance.stop();
	instance = null;
	if (segmenter) {
		const seg = segmenter.flush();
		if (seg) {
			console.log(`[vad] segment ${fmtSegment(seg)}`);
			trackSegments.push(seg);
		}
		segmenter = null;
	}
	isolator = null;
	if (cpuStart) {
		const cpu = process.cpuUsage(cpuStart);
		const wall = (process.uptime() - cpuStartTime) * 1000;
		console.log(
			`[loopback] stopped — cpu=${((cpu.user + cpu.system) / 1000).toFixed(1)}ms over ${wall.toFixed(0)}ms wall`
		);
	}
	cpuStart = null;
}
