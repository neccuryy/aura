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

// Hysteresis VAD over variable-duration frames of vocal-band RMS.
// The noise floor adapts (drops instantly to quiet frames, creeps up slowly
// toward louder ones), so the threshold tracks the instrumental bed of the
// mix instead of a fixed absolute level.
const ENTER_TIME = 0.15; // s of voice above threshold to open a segment
const EXIT_TIME = 0.4;   // s below to close — hangover bridges short breaths
const MIN_SEGMENT = 0.3; // s — drop blips (system sounds, clicks)
const MERGE_GAP = 0.3;   // s — bridge short pauses inside a sung line
const FLOOR_HEADROOM = 2;   // threshold = noise floor × this
const FLOOR_ABS = 0.004;    // absolute threshold floor (digital-silence guard)
const FLOOR_WINDOW = 100;   // frames (~5s) the noise floor is computed over
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

	// midRms/sideRms: bandpassed mid/side frame levels. The instrumental bed
	// leaks into mid, but stereo instruments land in side — subtracting side
	// from mid suppresses the bed and keeps the center-panned voice.
	// returns a finished segment when one closes (merge-delayed), else null
	onFrame(midRms: number, sideRms: number, dur: number, tStart: number): VocalSegment | null {
		const rms = Math.max(0, midRms - sideRms);
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
}
