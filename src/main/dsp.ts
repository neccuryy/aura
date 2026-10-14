// Classic DSP for vocal detection — no neural nets, no FFT, no dependencies.
// Everything is O(samples) cheap math so the weakest PC pays ~nothing.

// RBJ audio-equivalence-cookbook biquad, direct form 1
export class Biquad {
	private readonly b0: number;
	private readonly b1: number;
	private readonly b2: number;
	private readonly a1: number;
	private readonly a2: number;
	private x1 = 0;
	private x2 = 0;
	private y1 = 0;
	private y2 = 0;

	private constructor(b0: number, b1: number, b2: number, a1: number, a2: number) {
		this.b0 = b0;
		this.b1 = b1;
		this.b2 = b2;
		this.a1 = a1;
		this.a2 = a2;
	}

	static highpass(fs: number, f: number, q = Math.SQRT1_2): Biquad {
		const w0 = (2 * Math.PI * f) / fs;
		const cw = Math.cos(w0);
		const alpha = Math.sin(w0) / (2 * q);
		const a0 = 1 + alpha;
		return new Biquad(
			(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0,
			(-2 * cw) / a0, (1 - alpha) / a0
		);
	}

	static lowpass(fs: number, f: number, q = Math.SQRT1_2): Biquad {
		const w0 = (2 * Math.PI * f) / fs;
		const cw = Math.cos(w0);
		const alpha = Math.sin(w0) / (2 * q);
		const a0 = 1 + alpha;
		return new Biquad(
			(1 - cw) / 2 / a0, (1 - cw) / a0, (1 - cw) / 2 / a0,
			(-2 * cw) / a0, (1 - alpha) / a0
		);
	}

	processSample(x: number): number {
		const y =
			this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 -
			this.a1 * this.y1 - this.a2 * this.y2;
		this.x2 = this.x1;
		this.x1 = x;
		this.y2 = this.y1;
		this.y1 = y;
		return y;
	}
}

// Mid/side split + 4th-order bandpass 300–3400 Hz (the speech band).
// Vocals sit dead center in a stereo mix, so mid = (L+R)/2 keeps the voice;
// stereo-widened instruments (guitars, synths, reverb) land in side = (L−R)/2.
// The bandpass then cuts bass/drums below 300 Hz and cymbals/hiss above
// 3400 Hz. Both channels are filtered so their levels stay comparable —
// the VAD subtracts side from mid to suppress the instrumental bed.
export class VoiceIsolator {
	private readonly midStages: Biquad[];
	private readonly sideStages: Biquad[];

	constructor(sampleRate: number) {
		const band = () => [
			Biquad.highpass(sampleRate, 300),
			Biquad.highpass(sampleRate, 300),
			Biquad.lowpass(sampleRate, 3400),
			Biquad.lowpass(sampleRate, 3400),
		];
		this.midStages = band();
		this.sideStages = band();
	}

	// input: interleaved float32 stereo; outputs: `frames` bandpassed
	// mid and side samples (side stays zero for mono input)
	process(input: Float32Array, channels: number, frames: number,
		outMid: Float32Array, outSide: Float32Array): void {
		const stereo = channels >= 2;
		for (let i = 0; i < frames; i++) {
			const l = input[i * channels];
			const r = stereo ? input[i * channels + 1] : l;
			let m = (l + r) / 2;
			let s = (l - r) / 2;
			for (let k = 0; k < this.midStages.length; k++) m = this.midStages[k].processSample(m);
			for (let k = 0; k < this.sideStages.length; k++) s = this.sideStages[k].processSample(s);
			outMid[i] = m;
			outSide[i] = s;
		}
	}
}

export interface VocalSegment {
	start: number; // seconds since capture start
	end: number;
}

// ── VLS (Vocal Likelihood Score) ──────────────────────────────────────────
// A bare speech-band RMS level cannot separate vocals from a dense
// center-panned instrumental bed (the bed leaks into mid at a comparable
// level the whole track). Two classic signatures do separate them:
//  - syllable-rate amplitude modulation (3–8 Hz): vowels open and close
//    several times a second; pads/sustained guitars modulate near 0 Hz
//  - zero-crossing rate: hi-hats/cymbals leakage sits at the top of the
//    band, voiced vocals at the bottom
// VLS = bandpassedRMS × R_mod, computed per 20 ms sub-frame.

export const SUBFRAME_SEC = 0.02; // 20 ms — envelope rate 50 Hz (plan §3.2)
const ENV_FRAMES = 50;       // 1 s of envelope history for R_mod
const MOD_HP = 3;            // Hz — syllable modulation band
const MOD_LP = 8;
// A global floor on R_mod (vls = rms × max(rmod, F)) was tried for layer 1
// (VAD recall) and REJECTED by benchmark: F=0.5 scored 14374ms vs the 6604ms
// base (+118%). The floor keeps instrumental interludes above the threshold
// too — the VAD never exits, segments fuse into mega-segments (rawSegs
// 25→9 on ангелы, 36→9 on игрушка) and the DP loses its boundaries. The
// bed is NOT at the p20 level during loud sections — p20 tracks the quiet
// parts, so "4× below threshold" reasoning does not hold there.
// (The old ZCR gate is gone: after the 3.4 kHz lowpass, zcr 0.35 crossings/
// sample is unreachable — a 3.4 kHz sine at 48 kHz crosses ~0.14/sample —
// it fired 0/433 times on the corpus. zcr stays in the feature dump for
// diagnostics only.)

export interface SubframeFeatures {
	t: number;
	rms: number;
	zcr: number;
	rmod: number;
	vls: number;
}

export class VocalScorer {
	private readonly subFrames: number;
	private readonly env: number[] = [];      // raw envelope ring
	private readonly envMod: number[] = [];   // bandpassed envelope ring
	private readonly modHp: Biquad;
	private readonly modLp: Biquad;

	constructor(sampleRate: number) {
		this.subFrames = Math.max(1, Math.round(sampleRate * SUBFRAME_SEC));
		const envFs = 1 / SUBFRAME_SEC;
		this.modHp = Biquad.highpass(envFs, MOD_HP);
		this.modLp = Biquad.lowpass(envFs, MOD_LP);
	}

	// mid: bandpassed mid-channel samples for one capture chunk
	processChunk(mid: Float32Array, frames: number, tStart: number): SubframeFeatures[] {
		const out: SubframeFeatures[] = [];
		for (let off = 0; off < frames; off += this.subFrames) {
			const n = Math.min(this.subFrames, frames - off);
			let sumSq = 0;
			let crossings = 0;
			let prev = mid[off];
			for (let i = 0; i < n; i++) {
				const x = mid[off + i];
				sumSq += x * x;
				if ((x >= 0 && prev < 0) || (x < 0 && prev >= 0)) crossings++;
				prev = x;
			}
			const rms = Math.sqrt(sumSq / n);
			const zcr = n > 1 ? crossings / (n - 1) : 0;
			// envelope bandpass 3–8 Hz — stateful, fed once per sub-frame
			const mod = this.modLp.processSample(this.modHp.processSample(rms));
			this.env.push(rms);
			this.envMod.push(mod);
			if (this.env.length > ENV_FRAMES) {
				this.env.shift();
				this.envMod.shift();
			}
			let envSq = 0, modSq = 0;
			for (let i = 0; i < this.env.length; i++) {
				envSq += this.env[i] * this.env[i];
				modSq += this.envMod[i] * this.envMod[i];
			}
			const envRms = Math.sqrt(envSq / this.env.length);
			const modRms = Math.sqrt(modSq / this.envMod.length);
			const rmod = envRms > 1e-4 ? modRms / envRms : 0;
			const t = tStart + off / this.subFrames * SUBFRAME_SEC;
			out.push({ t, rms, zcr, rmod, vls: rms * rmod });
		}
		return out;
	}
}

// ── full per-chunk DSP pipeline ───────────────────────────────────────────
// One object runs everything between raw PCM and VAD segments so the live
// capture path and the offline benchmark execute literally the same code.

export interface PipelineChunkResult {
	segment: VocalSegment | null; // closed (merge-delayed) segment, if any
	midRms: number;               // chunk-level bandpassed mid RMS (logging)
	sideRms: number;
	energy: { t: number; e: number }[]; // per-sub-frame VLS samples
	features: SubframeFeatures[];       // full per-sub-frame feature dump
}

export class VocalPipeline {
	private readonly isolator: VoiceIsolator;
	private readonly scorer: VocalScorer;
	vad: VadSegmenter; // swapped whole by the per-track calibrator (Sprint F)
	private midBuf: Float32Array;
	private sideBuf: Float32Array;

	constructor(sampleRate: number, adoptVad?: VadSegmenter) {
		this.isolator = new VoiceIsolator(sampleRate);
		this.scorer = new VocalScorer(sampleRate);
		this.vad = adoptVad || new VadSegmenter();
		this.midBuf = new Float32Array(0);
		this.sideBuf = new Float32Array(0);
	}

	// Sprint F: swap in a re-parameterized, replayed VAD (per-track
	// calibration switch) — isolator/scorer state is point-independent
	adoptVad(vad: VadSegmenter): void {
		this.vad = vad;
	}

	// input: interleaved float32 PCM (any channel count ≥ 1)
	onChunk(input: Float32Array, channels: number, frames: number, tStart: number): PipelineChunkResult {
		if (this.midBuf.length < frames) {
			this.midBuf = new Float32Array(frames);
			this.sideBuf = new Float32Array(frames);
		}
		const mid = this.midBuf;
		const side = this.sideBuf;
		this.isolator.process(input, channels, frames, mid, side);
		let mss = 0, sss = 0;
		for (let i = 0; i < frames; i++) {
			mss += mid[i] * mid[i];
			sss += side[i] * side[i];
		}
		const feats = this.scorer.processChunk(mid, frames, tStart);
		let segment: VocalSegment | null = null;
		for (const f of feats) {
			const seg = this.vad.onFrame(f.vls, SUBFRAME_SEC, f.t);
			if (seg) segment = seg;
		}
		return {
			segment,
			midRms: Math.sqrt(mss / frames),
			sideRms: Math.sqrt(sss / frames),
			energy: feats.map((f) => ({ t: f.t, e: f.vls })),
			features: feats
		};
	}

	// drain merge-delayed segments on capture stop
	flush(): VocalSegment[] {
		return this.vad.flush();
	}

	// seek: the track position jumped, so the open segment's timeline is
	// cut at the seek moment — the pre-seek part is delivered immediately
	// (no merge delay: merging it with post-seek vocals would create one
	// segment spanning the jump), and the segment restarts at t
	splitAt(t: number): VocalSegment[] {
		return this.vad.splitAt(t);
	}
}

// Hysteresis VAD over variable-duration frames of vocal-band RMS.
// The noise floor adapts (drops instantly to quiet frames, creeps up slowly
// toward louder ones), so the threshold tracks the instrumental bed of the
// mix instead of a fixed absolute level.
// ENTER: evidence accumulator instead of a continuous above-threshold run.
// +1 per above-threshold frame, −ENTER_DECAY per below-threshold frame,
// open at ENTER_EVIDENCE net frames (~80 ms net). Measured on the corpus:
// 84% of missed line starts were above-threshold bursts fragmented by R_mod
// dips — shorter than a continuous 150 ms run (114 of 245 even < 40 ms), so
// a continuous ENTER_TIME can never catch them no matter how low. The
// accumulator counts fragmented activity (1 1 0 1 1 0 1 1 1 → 4) instead of
// resetting on every dip. Offline sim on real features: onset recall
// 36.3% → 46.5% with the exit condition untouched — the rmod-floor lesson:
// never weaken the HOLD condition (it fused segments through instrumental
// interludes, +118% MAE).
const ENTER_EVIDENCE = 4;  // net above-threshold frames to open a segment
const ENTER_DECAY = 0.5;   // evidence lost per below-threshold frame
const EXIT_TIME = 0.4;   // s below to close — hangover bridges short breaths
const MIN_SEGMENT = 0.3; // s — drop blips (system sounds, clicks)
const MERGE_GAP = 0.3;   // s — bridge short pauses inside a sung line
const FLOOR_HEADROOM = 2;       // threshold = noise floor × this
const FLOOR_ABS = 0.001;    // absolute threshold floor (digital-silence guard)
const FLOOR_WINDOW = 100;   // frames (2s at 20ms sub-frames) for the floor
const FLOOR_PERCENTILE = 0.2; // 20th percentile of the window = the bed level

// Sprint F: a VAD operating point. One global point overfits (the offline
// sweep on 32 tracks: buried AI vocals need a low threshold, ordinary
// mixes are already served by the default) — the live calibrator
// (calibrate.ts) picks a point per track; the default is what production
// used before and stays the fallback.
export interface VadPoint {
	headroom: number;      // threshold = noise floor × this
	enterEvidence: number; // net above-threshold frames to open a segment
}
export const DEFAULT_VAD_POINT: VadPoint = {
	headroom: FLOOR_HEADROOM,
	enterEvidence: ENTER_EVIDENCE
};

export class VadSegmenter {
	readonly headroom: number;      // operating point (Sprint F)
	readonly enterEvidence: number;
	private readonly window: number[] = []; // recent effective-frame RMS values
	private sorted: number[] = [];
	private inSegment = false;
	private segStart = 0;
	private evidence = 0;      // net above-threshold frames (enter accumulator)
	private evidenceStart = 0; // first frame of the current evidence stretch
	private belowTime = 0;
	private lastT = 0;
	private pending: VocalSegment | null = null; // held for possible merge

	constructor(point: VadPoint = DEFAULT_VAD_POINT) {
		this.headroom = point.headroom;
		this.enterEvidence = point.enterEvidence;
	}

	get active(): boolean {
		return this.inSegment;
	}

	get currentStart(): number {
		return this.segStart;
	}

	private noiseFloor(): number {
		if (this.window.length === 0) return FLOOR_ABS / this.headroom;
		// percentile of the recent window — robust against both blips
		// (a single quiet frame no longer collapses the floor) and vocal
		// passages (a few loud frames no longer drag it up)
		this.sorted = this.window.slice().sort((a, b) => a - b);
		const idx = Math.min(
			this.sorted.length - 1,
			Math.floor(this.sorted.length * FLOOR_PERCENTILE)
		);
		return this.sorted[idx];
	}

	get threshold(): number {
		return Math.max(this.noiseFloor() * this.headroom, FLOOR_ABS);
	}

	// level: per-frame vocal-likelihood (VLS). The noise floor adapts to the
	// recent window so the threshold tracks the instrumental bed instead of
	// a fixed absolute level.
	// returns a finished segment when one closes (merge-delayed), else null
	onFrame(level: number, dur: number, tStart: number): VocalSegment | null {
		const rms = Math.max(0, level);
		this.lastT = tStart + dur;
		this.window.push(rms);
		if (this.window.length > FLOOR_WINDOW) this.window.shift();
		const threshold = Math.max(this.noiseFloor() * this.headroom, FLOOR_ABS);
		const speech = rms > threshold;

		if (!this.inSegment) {
			if (speech) {
				if (this.evidence <= 0) this.evidenceStart = tStart;
				this.evidence += 1;
				if (this.evidence >= this.enterEvidence) {
					this.inSegment = true;
					// backdate to the first frame of the evidence stretch
					this.segStart = this.evidenceStart;
					this.evidence = 0;
					this.belowTime = 0;
				}
			} else {
				this.evidence = Math.max(0, this.evidence - ENTER_DECAY);
			}
			return null;
		}

		if (!speech) {
			this.belowTime += dur;
			if (this.belowTime >= EXIT_TIME) {
				// backdate the end to the first frame that went below
				return this.close(tStart - (this.belowTime - dur));
			}
		} else {
			this.belowTime = 0;
		}
		return null;
	}

	private close(end: number): VocalSegment | null {
		this.inSegment = false;
		this.evidence = 0;
		this.belowTime = 0;
		const seg: VocalSegment = { start: this.segStart, end };
		if (seg.end - seg.start < MIN_SEGMENT) return null;
		if (this.pending && seg.start - this.pending.end <= MERGE_GAP) {
			this.pending.end = seg.end; // bridge the pause inside a line
			return null;
		}
		const out = this.pending;
		this.pending = seg;
		return out;
	}

	// final drain on capture stop — returns EVERY held segment: the
	// merge-delayed holder plus the just-closed one. The old single-return
	// flush silently DROPPED the held segment when the final close didn't
	// merge into it (close() returns the old pending, which flush ignored)
	// — measured: it cost the second-to-last segment of tracks that end
	// mid-vocal (3/18 real-corpus tracks, e.g. ВЫКЛЮЧАТЕЛЬ 5257→1752ms)
	flush(): VocalSegment[] {
		const out: VocalSegment[] = [];
		if (this.inSegment) {
			const held = this.close(this.lastT);
			if (held) out.push(held);
		}
		if (this.pending) out.push(this.pending);
		this.pending = null;
		return out;
	}

	// seek cut: deliver the pre-seek part of the open segment (plus any
	// merge-delayed segment) immediately and restart the segment at t —
	// the vocals continue, but on the other side of the position jump
	splitAt(t: number): VocalSegment[] {
		if (!this.inSegment) {
			const out = this.pending ? [this.pending] : [];
			this.pending = null;
			return out;
		}
		const seg: VocalSegment = { start: this.segStart, end: t };
		this.segStart = t;
		this.evidence = 0;
		this.belowTime = 0;
		const out: VocalSegment[] = [];
		if (this.pending) out.push(this.pending);
		if (seg.end - seg.start >= MIN_SEGMENT) out.push(seg);
		this.pending = null;
		return out;
	}
}

// Sprint F: re-segment a recorded vls stream at an arbitrary operating
// point — a fresh parameterized VadSegmenter replayed over the samples.
// Segmentation is a pure function of the stream + point (proven by the
// offline sweep), so the live calibrator scores alternative points on
// the heard prefix with exactly the production segmenter logic. Returns
// the closed segments (merge-delayed holder drained, the still-open
// segment closed at the last sample).
export function resegmentStream(
	samples: { t: number; v: number }[],
	point: VadPoint
): VocalSegment[] {
	const vad = new VadSegmenter(point);
	const segs: VocalSegment[] = [];
	for (const s of samples) {
		const seg = vad.onFrame(s.v, SUBFRAME_SEC, s.t);
		if (seg) segs.push(seg);
	}
	for (const seg of vad.flush()) segs.push(seg);
	return segs;
}
