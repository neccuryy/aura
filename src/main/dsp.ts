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
// VLS = bandpassedRMS × R_mod × zcrGate, computed per 20 ms sub-frame.

const SUBFRAME_SEC = 0.02;   // 20 ms — envelope rate 50 Hz (plan §3.2)
const ENV_FRAMES = 50;       // 1 s of envelope history for R_mod
const MOD_HP = 3;            // Hz — syllable modulation band
const MOD_LP = 8;
const ZCR_HIGH = 0.35;       // crossings/sample — above this reads as
                             // percussion/noise leakage, not voice
const ZCR_GATE_LOW = 0.1;    // gate value when ZCR is too high

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
			const zcrGate = zcr > ZCR_HIGH ? ZCR_GATE_LOW : 1;
			const t = tStart + off / this.subFrames * SUBFRAME_SEC;
			out.push({ t, rms, zcr, rmod, vls: rms * rmod * zcrGate });
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
	readonly vad: VadSegmenter;
	private midBuf: Float32Array;
	private sideBuf: Float32Array;

	constructor(sampleRate: number, adoptVad?: VadSegmenter) {
		this.isolator = new VoiceIsolator(sampleRate);
		this.scorer = new VocalScorer(sampleRate);
		this.vad = adoptVad || new VadSegmenter();
		this.midBuf = new Float32Array(0);
		this.sideBuf = new Float32Array(0);
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
	flush(): VocalSegment | null {
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
const ENTER_TIME = 0.15; // s of voice above threshold to open a segment
const EXIT_TIME = 0.4;   // s below to close — hangover bridges short breaths
const MIN_SEGMENT = 0.3; // s — drop blips (system sounds, clicks)
const MERGE_GAP = 0.3;   // s — bridge short pauses inside a sung line
const FLOOR_HEADROOM = 2;   // threshold = noise floor × this
const FLOOR_ABS = 0.001;    // absolute threshold floor (digital-silence guard)
const FLOOR_WINDOW = 100;   // frames (2s at 20ms sub-frames) for the floor
const FLOOR_PERCENTILE = 0.2; // 20th percentile of the window = the bed level

export class VadSegmenter {
	private readonly window: number[] = []; // recent effective-frame RMS values
	private sorted: number[] = [];
	private inSegment = false;
	private segStart = 0;
	private aboveTime = 0;
	private belowTime = 0;
	private lastT = 0;
	private pending: VocalSegment | null = null; // held for possible merge

	get active(): boolean {
		return this.inSegment;
	}

	get currentStart(): number {
		return this.segStart;
	}

	private noiseFloor(): number {
		if (this.window.length === 0) return FLOOR_ABS / FLOOR_HEADROOM;
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
		return Math.max(this.noiseFloor() * FLOOR_HEADROOM, FLOOR_ABS);
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
		const threshold = Math.max(this.noiseFloor() * FLOOR_HEADROOM, FLOOR_ABS);
		const speech = rms > threshold;

		if (!this.inSegment) {
			if (speech) {
				this.aboveTime += dur;
				if (this.aboveTime >= ENTER_TIME) {
					this.inSegment = true;
					// backdate to the first frame that went above
					this.segStart = tStart - (this.aboveTime - dur);
					this.belowTime = 0;
				}
			} else {
				this.aboveTime = 0;
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
		this.aboveTime = 0;
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

	// final drain on capture stop
	flush(): VocalSegment | null {
		if (this.inSegment) this.close(this.lastT);
		const out = this.pending;
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
		this.aboveTime = 0;
		this.belowTime = 0;
		const out: VocalSegment[] = [];
		if (this.pending) out.push(this.pending);
		if (seg.end - seg.start >= MIN_SEGMENT) out.push(seg);
		this.pending = null;
		return out;
	}
}
