// Sprint F: per-track VAD operating-point calibration (live).
// One global operating point overfits — the user's diagnosis, confirmed by
// the offline sweep on 32 tracks (both corpora): buried/distorted AI vocals
// need a low threshold (the default point is deaf → the tempo estimate on
// the segment-gated envelope abstains), ordinary mixes are already served
// by the default (tempo confident). The tempo abstain IS the regime
// detector; switching only on it scored −30%/−23% MAE with ZERO
// catastrophic regressions (worst +562ms) on the sweep.
//
// This module is pure: the live path (index.ts) feeds it the heard stream,
// and the offline validator (.benchmark/calib-live.js) feeds it a decoded
// prefix — the exact same shipped decision logic, so the offline numbers
// are the live numbers.

import { VadPoint, DEFAULT_VAD_POINT, resegmentStream } from "./dsp";
import { alignLyrics, estimateTempoScored, countSyllables, isAlignable, AlignStats } from "./align";

// heard stream (track time) needed before the first check. The tempo
// estimate needs ≥12s of support, but a SHORT prefix abstains on healthy
// tracks too (the autocorrelation support is still growing): measured on
// both corpora, the 45s prefix guard false-switched 5 healthy AI tracks
// (не.кури +9930ms, я так не люблю +2748ms catastrophes); at 90s the
// prefix guard matches the full-track guard with ZERO false switches and
// the end-to-end flow has zero catastrophes on both corpora (AI 7146→5208,
// real 6462→5067, worst regression +1977ms). 120s loses wins instead.
export const CALIB_MIN_HEARD = 90;

// the two alternative points the sweep validated (the "R2" set ≈ the full
// 8-point sweep): a lower threshold for buried vocals, and the strict-enter
// variant that filters the bed-noise fragments the loose enter admits
export const ALT_VAD_POINTS: VadPoint[] = [
	{ headroom: 1.75, enterEvidence: 4 },
	{ headroom: 1.5, enterEvidence: 6 }
];

const EXP_SUNG_S = 0.23; // s of expected singing per (syllable × line)
const GATE_FRAC = 0.7;   // a candidate must hear ≥70% of the expected sung time

export function samePoint(a: VadPoint, b: VadPoint): boolean {
	return a.headroom === b.headroom && a.enterEvidence === b.enterEvidence;
}

// Decide the operating point from the heard evidence (all in TRACK time):
//   energy   — heard vls envelope (getTrackEnergy / decoded prefix)
//   segments — the DEFAULT point's segments over the heard span (closed +
//              open — what the live segmenter produced so far)
//   lines    — the plain lyrics being aligned
// Returns DEFAULT_VAD_POINT for the ordinary-mix regime (guard healthy or
// the default wins the scoring), else the alternative point that fits best.
export function calibrateVadPoint(
	energy: { t: number; e: number }[],
	segments: { start: number; end: number }[],
	lines: { text: string }[],
	trackLength: number
): VadPoint {
	const singable = lines.filter((l) => isAlignable(l.text));
	if (!singable.length || energy.length < 2) return DEFAULT_VAD_POINT;
	const sylls = singable.map((l) => countSyllables(l.text));
	const avgSylls = sylls.reduce((a, b) => a + b, 0) / sylls.length;
	if (avgSylls <= 0) return DEFAULT_VAD_POINT;

	// guard: tempo on the segment-gated envelope at the DEFAULT point. A
	// confident rate means the default point hears the vocals — the
	// ordinary-mix regime; moving the point only risks the tracks it
	// already serves (the sweep's two catastrophes were exactly those:
	// не.кури +9930ms, я так не люблю +2748ms, both tempo-confident)
	const gated = energy.map((s) => ({
		t: s.t,
		e: segments.some((g) => s.t >= g.start && s.t <= g.end) ? s.e : 0
	}));
	if (estimateTempoScored(gated, avgSylls).rate > 0) return DEFAULT_VAD_POINT;

	// sick regime: score the default + the alternatives on the heard span.
	// expRef is the FULL-track expected sung time (avgSylls × lines × 0.23,
	// from the lyrics text alone — no truth); scale it to the heard fraction
	// so the gate keeps its full-track meaning on a prefix
	const heardEnd = energy[energy.length - 1].t;
	const heardSpan = heardEnd - energy[0].t;
	const expRef = avgSylls * singable.length * EXP_SUNG_S;
	const scaledExp =
		trackLength > 0 ? expRef * Math.min(1, heardSpan / trackLength) : expRef;
	const stream = energy.map((s) => ({ t: s.t, v: s.e }));
	const cands: { point: VadPoint; segs: { start: number; end: number }[]; vocSec: number; fitSym: number }[] = [];
	const score = (point: VadPoint, segs: { start: number; end: number }[]): void => {
		const stats: Partial<AlignStats> = {};
		// live-mode solve (now = heard end): only lines the heard evidence
		// can explain enter the DP — the same fit the live aligner computes
		alignLyrics(lines, segs, trackLength, energy, stats, heardEnd);
		cands.push({
			point,
			segs,
			vocSec: segs.reduce((a, g) => a + (g.end - g.start), 0),
			fitSym: stats.fitSym ?? Infinity
		});
	};
	score(DEFAULT_VAD_POINT, segments);
	for (const p of ALT_VAD_POINTS) score(p, resegmentStream(stream, p));

	// fitGate: among the points that hear enough vocal time, the tightest
	// symmetric fit; if none clears the gate, the best fit over all points
	const gatedCands = cands.filter((c) => c.vocSec >= GATE_FRAC * scaledExp);
	const pool = gatedCands.length ? gatedCands : cands;
	return pool.reduce((b, c) => (c.fitSym < b.fitSym ? c : b), pool[0]).point;
}
