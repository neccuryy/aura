// WASAPI loopback capture → vocal-band DSP → VAD segments.
// The native addon (native/loopback) only captures; everything else —
// mid-side extraction, bandpass, voice activity detection — happens here
// in TypeScript. Dev only (started when !app.isPackaged) until Stage 2
// turns segments into synced lyrics.

import * as path from "path";
import { VocalPipeline, VadSegmenter, VocalSegment } from "./dsp";

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
let pipeline: VocalPipeline | null = null;

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
let lastChunkWall = 0; // wall clock of the last delivered chunk — watchdog input
let isStartingLoopback = false; // guard against duplicate startLoopback calls

// Stage 2 track clock: SMTC position samples pair the capture timeline
// with the track timeline so vocal segments can be mapped into track
// seconds. Each consecutive sample pair is classified (план item 5):
// PLAY — the position advances with the capture clock; PAUSE — the
// position is frozen while silence chunks still advance the capture
// clock; SEEK — the position jumped (backward at all, or forward faster
// than real time). Consecutive PLAY pairs form a "stretch" fitted with a
// Theil-Sen robust line (median of pairwise slopes — SMTC reporting
// jitter can't bend it); pauses and seeks break stretches, so the mapping
// freezes across pauses and jumps cleanly across seeks.
interface TrackSample {
	captureT: number;
	trackT: number;
}
type PairClass = "play" | "pause" | "seek";
interface ClockStretch {
	first: number; // sample index range within trackSamples
	last: number;
	alpha: number; // Theil-Sen fit: trackT ≈ alpha·captureT + beta
	beta: number;
	capFirst: number;
	trackFirst: number;
	capLast: number;
	trackLast: number;
}
let captureSampleRate = 0;
let trackSamples: TrackSample[] = [];
let sampleStretch: number[] = []; // stretch index per sample
let stretches: ClockStretch[] = [];
let trackSegments: VocalSegment[] = []; // closed segments of the current track
let trackStartT = 0; // capture time when the current track began
let lastPairClass: PairClass | null = null;
let evidenceCutCap = -Infinity; // capture time of the last seek — chunks older than it are stragglers
// vocal energy envelope (effective vocal RMS per chunk) in capture time —
// feeds intra-block segment refinement in the aligner
let energySamples: { t: number; e: number }[] = [];

const SEEK_JUMP_S = 1.5; // s — position vs capture clock beyond this = seek
const PAUSE_TRACK_S = 0.1; // s — position frozen within this = pause

export function captureTime(): number {
	return captureSampleRate ? totalFrames / captureSampleRate : 0;
}

// a new track started — vocal evidence collected so far belongs to the
// previous one; call BEFORE reading segments for the new track
export function beginTrack(): void {
	trackSamples = [];
	sampleStretch = [];
	stretches = [];
	trackSegments = [];
	energySamples = [];
	trackStartT = captureTime();
	lastPairClass = null;
	evidenceCutCap = -Infinity;
}

function classifyPair(prev: TrackSample, captureT: number, trackT: number): PairClass {
	const dCap = captureT - prev.captureT;
	const dTrack = trackT - prev.trackT;
	// paused player: the position freezes while the capture clock keeps
	// advancing (silence chunks still flow from the loopback device)
	if (Math.abs(dTrack) <= PAUSE_TRACK_S && dCap >= 0.3) return "pause";
	// position jumped: backward at all (an extrapolated position never
	// moves back on its own), or forward faster than the capture clock
	if (dTrack < -0.5 || dTrack > dCap + SEEK_JUMP_S) return "seek";
	return "play";
}

// Theil-Sen robust fit of one stretch: median of pairwise slopes (long
// baselines kill SMTC jitter; the stride keeps it O(n) on long stretches)
// and a median intercept. Frozen-capture pairs (watchdog death) contribute
// nothing — their baseline is zero.
function fitStretch(st: ClockStretch): void {
	const s = trackSamples;
	const n = st.last - st.first + 1;
	st.capFirst = s[st.first].captureT;
	st.trackFirst = s[st.first].trackT;
	st.capLast = s[st.last].captureT;
	st.trackLast = s[st.last].trackT;
	if (n < 2) {
		st.alpha = 1;
		st.beta = st.trackFirst - st.capFirst;
		return;
	}
	const stride = Math.max(1, Math.floor(n / 100));
	const slopes: number[] = [];
	for (let i = st.first; i + stride <= st.last; i++) {
		const dc = s[i + stride].captureT - s[i].captureT;
		if (dc > 0.05) slopes.push((s[i + stride].trackT - s[i].trackT) / dc);
	}
	slopes.sort((a, b) => a - b);
	const alpha = slopes.length ? slopes[Math.floor(slopes.length / 2)] : 1;
	st.alpha = Math.min(2, Math.max(0.5, alpha));
	const inter: number[] = [];
	for (let i = st.first; i <= st.last; i++) inter.push(s[i].trackT - st.alpha * s[i].captureT);
	inter.sort((a, b) => a - b);
	st.beta = inter[Math.floor(inter.length / 2)];
}

function newStretch(idx: number): ClockStretch {
	const st: ClockStretch = {
		first: idx,
		last: idx,
		alpha: 1,
		beta: 0,
		capFirst: trackSamples[idx].captureT,
		trackFirst: trackSamples[idx].trackT,
		capLast: trackSamples[idx].captureT,
		trackLast: trackSamples[idx].trackT
	};
	fitStretch(st);
	return st;
}

// recompute the whole stretch structure from the raw samples (after the
// watchdog pruned frozen samples or the rolling buffer dropped a chunk)
function rebuildClock(): void {
	stretches = [];
	sampleStretch = new Array<number>(trackSamples.length);
	for (let k = 0; k < trackSamples.length; k++) {
		const cls =
			k === 0
				? "play"
				: classifyPair(trackSamples[k - 1], trackSamples[k].captureT, trackSamples[k].trackT);
		if (k === 0 || cls !== "play") stretches.push(newStretch(k));
		else {
			const st = stretches[stretches.length - 1];
			st.last = k;
			fitStretch(st);
		}
		sampleStretch[k] = stretches.length - 1;
	}
}

// seek/replay: the open VAD segment is cut at the moment of the jump (its
// pre-seek part stays valid evidence for the pre-seek position), and on a
// backward jump everything mapped after the landing position is dropped —
// the player is about to replay that region and would otherwise collect
// near-duplicate segments (план item 5: "сбросить VAD-сегменты после
// new_track_pos")
function handleSeek(prev: TrackSample, captureT: number, trackT: number, backward: boolean): void {
	if (pipeline) {
		for (const seg of pipeline.splitAt(captureT)) {
			console.log(`[vad] segment ${fmtSegment(seg)} (seek cut)`);
			trackSegments.push(seg);
		}
	}
	// chunks already in flight (captured before the seek, delivered after
	// the filters below) must not land after the filtered arrays — their
	// capture times predate the cut, so the chunk callback drops them
	evidenceCutCap = captureT;
	if (!backward) {
		console.log(`[clock] seek ${prev.trackT.toFixed(1)}→${trackT.toFixed(1)}s (forward)`);
		return;
	}
	const keepFrom = trackT + 0.5; // small slack for mapping jitter
	const segsBefore = trackSegments.length;
	trackSegments = trackSegments.filter((s) => captureToTrack(s.start) <= keepFrom);
	const energyBefore = energySamples.length;
	energySamples = energySamples.filter((e) => captureToTrack(e.t) <= keepFrom);
	console.log(
		`[clock] seek ${prev.trackT.toFixed(1)}→${trackT.toFixed(1)}s (backward): dropped ${segsBefore - trackSegments.length} segments, ${energyBefore - energySamples.length} energy samples`
	);
}

// SMTC position tick (500ms poll loop) — records the pairing needed to
// map capture time → track time and keeps the clock model honest across
// pauses and seeks
export function noteTrackPosition(trackT: number): void {
	if (!instance) return;
	const captureT = captureTime();
	const prev = trackSamples[trackSamples.length - 1];
	const cls: PairClass = prev ? classifyPair(prev, captureT, trackT) : "play";
	if (cls === "seek" && prev) handleSeek(prev, captureT, trackT, trackT < prev.trackT);
	trackSamples.push({ captureT, trackT });
	if (!prev || cls !== "play") stretches.push(newStretch(trackSamples.length - 1));
	else {
		const st = stretches[stretches.length - 1];
		st.last = trackSamples.length - 1;
		fitStretch(st);
	}
	sampleStretch.push(stretches.length - 1);
	if (cls !== lastPairClass) {
		if (cls === "pause") console.log(`[clock] pause @ track=${trackT.toFixed(1)}s`);
		else if (cls === "play" && lastPairClass === "pause")
			console.log(`[clock] resume @ track=${trackT.toFixed(1)}s`);
		lastPairClass = cls;
	}
	// bound the buffer — hours of playback still map fine via the stretches
	if (trackSamples.length > 20000) {
		trackSamples.splice(0, 10000);
		sampleStretch.splice(0, 10000);
		rebuildClock();
	}
}

// robust capture → track mapping: inside a playing stretch the Theil-Sen
// line clamped to the stretch's own track range (mapping stays monotone);
// across a pause or seek boundary the track stood at the previous value;
// outside the sample range the nearest stretch's line extrapolates
function captureToTrack(captureT: number): number {
	const s = trackSamples;
	if (s.length === 0) return 0;
	if (s.length === 1) return Math.max(0, s[0].trackT + (captureT - s[0].captureT));
	// binary search: first sample at/after the query
	let lo = 0;
	let hi = s.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (s[mid].captureT < captureT) lo = mid + 1;
		else hi = mid;
	}
	if (lo === 0) {
		const st = stretches[sampleStretch[0]];
		return Math.max(0, st.trackFirst + (captureT - st.capFirst) * st.alpha);
	}
	if (lo === s.length) {
		const st = stretches[sampleStretch[s.length - 1]];
		return st.trackLast + (captureT - st.capLast) * st.alpha;
	}
	if (classifyPair(s[lo - 1], s[lo].captureT, s[lo].trackT) !== "play") {
		// pause or seek boundary — the track stood at the previous value
		return s[lo - 1].trackT;
	}
	const st = stretches[sampleStretch[lo]];
	const t = st.beta + st.alpha * captureT;
	return Math.min(st.trackLast, Math.max(st.trackFirst, t));
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
	if (pipeline && pipeline.vad.active) {
		closed.push({ start: Math.max(pipeline.vad.currentStart, trackStartT), end: now });
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
	console.log(`[align] segs(track): ${out.map((s) => `${s.start.toFixed(1)}–${s.end.toFixed(1)}`).join(", ") || "(none)"}`);
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
	// any music plays; the VLS threshold is the column that should contrast
	const active = mix > floor * 3 && mix > 0.001;
	const thr = pipeline ? pipeline.vad.threshold : 0;
	const seg = pipeline ? (pipeline.vad.active ? 1 : 0) : 0;
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

// preserveTimeline: watchdog restart — the capture timeline (frames, clock
// samples, segments, VAD state) survives so evidence collected before the
// capture death stays valid; only the dead device handle is replaced
export function startLoopback(preserveTimeline = false, adoptVad?: VadSegmenter): void {
	if (instance || isStartingLoopback) return;
	isStartingLoopback = true;
	try {
		const addon: LoopbackAddon = require(path.join(
			__dirname, "..", "..", "native", "loopback", "build", "Release", "aura_loopback.node"
		));
		instance = new addon.Loopback();
	} catch (e) {
		console.log(`[loopback] addon unavailable: ${e instanceof Error ? e.message : e}`);
		isStartingLoopback = false;
		return;
	}

	secondIndex = 0;
	mixSumSquares = 0;
	midSumSquares = 0;
	sideSumSquares = 0;
	sampleCount = 0;
	peak = 0;
	if (!preserveTimeline) {
		floor = Infinity;
		totalFrames = 0;
		captureSampleRate = 0;
		trackSamples = [];
		sampleStretch = [];
		stretches = [];
		trackSegments = [];
		energySamples = [];
		trackStartT = 0;
		lastPairClass = null;
		evidenceCutCap = -Infinity;
		pipeline = null; // built on the first chunk (needs the real sample rate)
	}
	lastChunkWall = Date.now();
	cpuStart = process.cpuUsage();
	cpuStartTime = process.uptime();

	const onChunk = (arg: Error | LoopbackChunk): void => {
		isStartingLoopback = false; // allow restart after a failure
		if (arg instanceof Error) {
			console.log(`[loopback] capture error: ${arg.message}`);
			return;
		}
		lastChunkWall = Date.now();
		const chunk = arg;
		
		// Validate chunk data size is valid for Float32 parsing
		if (chunk.data.byteLength % 4 !== 0) {
			console.error(`[loopback] Invalid chunk size: ${chunk.data.byteLength} bytes (not divisible by 4)`);
			return;
		}
		// pipeline is rebuilt whenever the sample rate changes (device
		// switch after a capture death) — totalFrames is rescaled so
		// captureTime() stays continuous across the restart
		if (!pipeline || chunk.sampleRate !== captureSampleRate) {
			if (captureSampleRate && captureSampleRate !== chunk.sampleRate) {
				totalFrames = Math.round((totalFrames * chunk.sampleRate) / captureSampleRate);
			}
			pipeline = new VocalPipeline(chunk.sampleRate, adoptVad);
			captureSampleRate = chunk.sampleRate;
		}

		const samples = new Float32Array(
			chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength / 4
		);
		const frames = samples.length / chunk.channels;

		// full-mix RMS + peak (observability column)
		for (let i = 0; i < samples.length; i++) {
			const s = samples[i];
			mixSumSquares += s * s;
			const a = Math.abs(s);
			if (a > peak) peak = a;
		}

		const tStart = totalFrames / chunk.sampleRate;
		totalFrames += frames;
		const wasActive = pipeline.vad.active;
		// isolator → VLS scorer → VAD, per 20ms sub-frames
		const res = pipeline.onChunk(samples, chunk.channels, frames, tStart);
		for (const e of res.energy) {
			// strict >: a sub-frame at exactly the cut instant straddles the
			// seek — the boundary rule would map it to the pre-seek position
			// and the monotone dedupe in getTrackEnergy would then swallow
			// every post-seek sample after it
			if (e.t > evidenceCutCap) energySamples.push(e);
		}
		if (energySamples.length > 100000) energySamples.splice(0, 50000);
		if (res.segment && res.segment.end > evidenceCutCap) {
			console.log(`[vad] segment ${fmtSegment(res.segment)}`);
			trackSegments.push(res.segment);
		}
		if (!wasActive && pipeline.vad.active) {
			console.log(`[vad] open @ ${pipeline.vad.currentStart.toFixed(1)}s`);
		}

		midSumSquares += res.midRms * res.midRms * frames;
		sideSumSquares += res.sideRms * res.sideRms * frames;
		sampleCount += frames;

		// one log line per second of audio
		if (sampleCount >= chunk.sampleRate) logSecond(chunk.channels);
	};

	// a synchronous throw from the native start() would leave
	// isStartingLoopback stuck true — no restart could ever run again
	try {
		instance.start(onChunk);
	} catch (e) {
		console.log(`[loopback] capture failed to start: ${e instanceof Error ? e.message : e}`);
		instance = null;
		isStartingLoopback = false;
		return;
	}

	isStartingLoopback = false; // allow watchdog restart after successful start
	console.log("[loopback] started (device-wide loopback, mid+bandpass+VAD)");
}

export function stopLoopback(): void {
	if (!instance) return;
	instance.stop();
	instance = null;
	isStartingLoopback = false; // allow future restarts
	if (pipeline) {
		const seg = pipeline.flush();
		if (seg) {
			console.log(`[vad] segment ${fmtSegment(seg)}`);
			trackSegments.push(seg);
		}
		pipeline = null;
	}
	if (cpuStart) {
		const cpu = process.cpuUsage(cpuStart);
		const wall = (process.uptime() - cpuStartTime) * 1000;
		console.log(
			`[loopback] stopped — cpu=${((cpu.user + cpu.system) / 1000).toFixed(1)}ms over ${wall.toFixed(0)}ms wall`
		);
	}
	cpuStart = null;
}

// while the capture was dead the poll loop kept recording clock samples
// with a frozen captureT — collapse those runs to a single sample so the
// stretch clock doesn't accumulate zero-baseline junk
function pruneFrozenSamples(): void {
	if (trackSamples.length < 2) return;
	const out: TrackSample[] = [trackSamples[0]];
	for (let k = 1; k < trackSamples.length; k++) {
		if (trackSamples[k].captureT !== out[out.length - 1].captureT) {
			out.push(trackSamples[k]);
		}
	}
	const dropped = trackSamples.length - out.length;
	trackSamples = out;
	if (dropped > 0) {
		console.log(`[loopback] watchdog: pruned ${dropped} frozen clock samples`);
	}
	// the surviving pairs now span the dead gap — reclassify and refit
	rebuildClock();
}

// replace the dead WASAPI instance while keeping the capture timeline:
// frames, clock samples, closed segments, energy envelope and the VAD's
// adaptive noise floor all survive; the open segment is closed at the last
// frame we saw so the dead gap never ends up inside a segment
export function restartLoopback(): void {
	console.log("[loopback] watchdog: capture stalled, restarting (timeline preserved)");
	if (pipeline) {
		// flush() drains one held segment per call (merge-delayed close) —
		// two calls empty both pending and the just-closed open segment
		for (let i = 0; i < 2; i++) {
			const seg = pipeline.flush();
			if (seg) {
				console.log(`[vad] segment ${fmtSegment(seg)}`);
				trackSegments.push(seg);
			}
		}
	}
	if (instance) {
		try {
			instance.stop();
		} catch {
			// already dead — that's why we're here
		}
		instance = null;
	}
	// the isolator/scorer must be rebuilt (sample rate may differ) but the
	// VAD's adaptive noise floor survives the restart
	const vad = pipeline ? pipeline.vad : undefined;
	pipeline = null;
	pruneFrozenSamples();
	startLoopback(true, vad);
}

const WATCHDOG_TIMEOUT = 5000; // ms without chunks while playing → restart

// called from the 500ms poll loop: WASAPI loopback silently stops
// delivering packets on device changes / exclusive-mode takeovers, and
// every track after that gets zero segments until the app restarts
export function checkLoopbackWatchdog(playing: boolean): void {
	if (!instance || !playing) return;
	if (Date.now() - lastChunkWall > WATCHDOG_TIMEOUT) restartLoopback();
}
