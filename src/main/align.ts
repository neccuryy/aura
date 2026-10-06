// Stage 2 — dynamic-programming alignment: match plain lyrics lines to
// VAD vocal segments and derive per-line timestamps. Pure classic DP:
// lines may be skipped (quiet/masked vocals the VAD missed), segments may
// be skipped (non-vocal noise), several lines may share one segment (fast
// delivery), and one line may span several segments (VAD over-split).

export interface AlignSegment {
	start: number;
	end: number;
}

// vocal energy envelope: effective vocal RMS (mid−side) sampled every
// capture chunk (~50–100ms), mapped into track time
export interface EnergySample {
	t: number;
	e: number;
}

export interface AlignLine {
	text: string;
	time: number;
}

// dev diagnostics: how much of the alignment is real evidence vs interpolation
export interface AlignStats {
	anchored: number; // lines assigned to vocal segments by the DP
	interpolated: number; // lines without evidence, filled by fillGaps
	segsUsed: number; // segments the DP assigned lines to
	segsSkipped: number; // segments skipped as unexplained
	cost: number; // total DP cost of the chosen alignment
	rate: number; // ms/syllable chosen by the per-track grid search
	expected: number; // total expected sung duration at that rate (s)
	refined: AlignSegment[]; // segment list after energy-dip splitting
	lineSeg?: number[]; // live: per-line anchor segment (group's last seg), -1 = interpolated
	lineEnd?: number[]; // live: per-line end time, -1 = unknown
	lineVoc?: number[]; // live: strict vocalness of the line's anchor (0.6×level), -1 = interpolated
	lineExp?: number[]; // live: per-line expected sung duration at the calibrated prior rate — Anchor Locking's oversized-seg gate; deliberately NOT the DP's per-block rate (a wrong fast-rate block inflates exp and would let a seg-stealing freeze through)
	lineSpan?: number[]; // live: per-line anchor group wall span, -1 = interpolated
	rawBlocks?: number; // live: raw VAD blocks heard — maturity of the level estimate
	normCost?: number; // live: DP cost per second of segment evidence (план item 6)
}

// Anchor Locking (план item 4): lines the playback position has passed
// with a stable segment binding freeze permanently; the next DP run
// solves only the remainder, starting at (lineIdx + 1, segIdx + 1)
export interface AlignLock {
	lineIdx: number; // last frozen line
	segIdx: number; // last segment covered by frozen lines (-1 if none anchored)
	times: number[]; // frozen start times, lines [0..lineIdx]
	lineSeg: number[]; // frozen per-line anchor segment (-1 = interpolated)
	lineEnd: number[]; // frozen per-line end times
	lineVoc: number[]; // frozen per-line anchor vocalness (-1 = interpolated)
}

const VOWELS = /[аеёиоуыэюяaeiouy]+/gi;
// calibrated on 333 synced Lrclib tracks (15k line spacings): median
// line-start-to-line-start pacing is 0.23s per syllable
const MS_PER_SYLLABLE = 230;
const MIN_LINE_DURATION = 0.4; // s — even a short line takes at least this
// rap vocals merge into long VAD blocks — a single block routinely holds
// 8+ lines; capping this low forces the DP to shove extra lines into the
// NEXT block, cascading shifts across the whole track
const MAX_LINES_PER_SEGMENT = 10;
const MAX_SEGMENTS_PER_LINE = 3;

// cost weights, per second
// asymmetric mismatch: a group's expected sung time running PAST its
// segments (under-span) is the normal case — VAD hysteresis clips line
// tails and misses breathy onsets, so real lines routinely sing beyond
// their detected segment. A segment running past the expected time
// (over-span) means something else is singing there — full price.
export const W_MIS_UNDER = 0.35; // exp sum exceeds segment span — VAD clipped
export const W_MIS_OVER = 1.0;   // segment span exceeds exp sum — suspicious
export const W_SKIP_LINE = 1.0; // expected line time the vocal evidence doesn't cover

// skip-price weights, per second of unexplained segment. Sustained
// center-panned instruments (synth/bass that leaked past mid−side) sit
// FLAT in the energy envelope; real vocals dip deeply between syllables
// and lines. A segment's modulation depth sets how expensive it is to
// leave it unexplained: instrumental (flat) is cheap to skip, vocal
// (modulated) is expensive — that keeps lines on their real segments
// while false intro/outro segments get skipped instead of filled
export const W_SKIP_BASE = 0.25;   // flat envelope — instrumental, cheap to skip
export const W_SKIP_VOCAL = 1.05;  // deeply modulated envelope — vocals, dear to skip
// mirror of the skip price: anchoring lines onto flat (instrumental)
// segments is exactly the false-outro failure — lines must not "explain"
// sustained synths as singing
export const W_FILL_FLAT = 2.0;    // per second of flat segment covered by a group

// inter-group wall-gap prior: between consecutive anchored groups the wall
// time must be explained — a short pause (GAP_FREE) plus the expected sung
// time of any lines skipped in between. Without this, homogeneous rap
// (every line ≈ every segment duration) makes a phase-shifted path locally
// perfect: the DP drifts lines into later and later segments and finally
// dumps the surplus into vocal-like outro chops, because every individual
// |span − exp| fit stays cheap. The drift accumulates ONLY as unexplained
// wall time between groups — pricing it kills the whole cascade.
export const W_GAP_EXCESS = 1.5;  // per second of unexplained inter-group gap
const GAP_FREE = 2.0; // s — normal inter-line/inter-section pause
// pass-1 inter-super silence: only this much gap excess beyond GAP_FREE is
// chargeable per boundary. The old DP's gap prior was LOCAL (3-segment
// lookback, avoidable by anchoring mid-super) — jumping a long break was
// free, and that locality was load-bearing: on sparse-VAD tracks the breaks
// are real (instrumental sections) or undetected vocals, and charging them
// in full makes cramming every line into the earliest supers cheaper
// (игрушка: 59 lines into one 5s super). Short unexplained gaps still
// charge — drift within a section stays expensive
const SILENCE_CAP = 4.0; // s of chargeable gap excess per boundary

// Two-Pass DP (план item 7): pass 1 aligns line BLOCKS (куплеты/припевы) to
// super-segments — VAD segments merged across pauses ≤ SUPER_GAP. Pauses
// longer than this are section boundaries and split the track into coarse
// units; block-level duration matching is shift-proof (a one-block slide
// costs a whole block of sung-time mismatch)
const SUPER_GAP = 2.0; // s — max pause inside a block

// per-track tempo grid — the median rate (230) is wrong for fast rap (~205)
// and slow singing; the DP fit cost itself picks the best rate per track
const RATE_MIN = 150;
const RATE_MAX = 280;
const RATE_STEP = 10;

export function countSyllables(text: string): number {
	const groups = text.toLowerCase().match(VOWELS);
	return groups ? groups.length : 0;
}

export function expectedDuration(syllables: number, msPerSyllable = MS_PER_SYLLABLE): number {
	return Math.max((syllables * msPerSyllable) / 1000, MIN_LINE_DURATION);
}

// section headers ("[Verse 1]") and blank separators carry no singable
// content — they'd only poison the alignment
function isAlignable(text: string): boolean {
	const t = text.trim();
	return t.length > 0 && !/^\[.+\]$/.test(t);
}

function roundTime(t: number): number {
	return Math.round(t * 100) / 100;
}

// asymmetric group-fit cost: under-span (expected singing runs past the
// segments — VAD clipped tails) is cheap, over-span is full price
function mismatchCost(span: number, sum: number): number {
	return sum > span ? W_MIS_UNDER * (sum - span) : W_MIS_OVER * (span - sum);
}

// monotonic, non-degenerate segment list: sorted, overlaps merged
export function cleanSegments(segs: AlignSegment[]): AlignSegment[] {
	const sorted = segs
		.filter((s) => s.end - s.start >= 0.2 && s.start >= 0)
		.sort((a, b) => a.start - b.start);
	const out: AlignSegment[] = [];
	for (const s of sorted) {
		const prev = out[out.length - 1];
		if (prev && s.start <= prev.end) prev.end = Math.max(prev.end, s.end);
		else out.push({ start: s.start, end: s.end });
	}
	return out;
}

// Long VAD blocks (continuous rap vocals) carry no interior anchors, so
// pacing error accumulates across the whole block (10s+ drift by the
// middle). Inside a block the vocal energy still dips between lines —
// split the block at deep local minima to give the DP real anchors.
const SPLIT_MIN_BLOCK = 6; // s — shorter blocks aren't worth splitting
const SPLIT_DIP_RATIO = 0.35; // dip qualifies at < 35% of the block's mean energy
const SPLIT_MIN_GAP = 1.0; // s — minimum distance between split points

export function refineSegments(segs: AlignSegment[], energy: EnergySample[]): AlignSegment[] {
	if (energy.length < 10) return segs;
	const out: AlignSegment[] = [];
	for (const s of segs) {
		if (s.end - s.start < SPLIT_MIN_BLOCK) {
			out.push(s);
			continue;
		}
		const inside = energy.filter((e) => e.t >= s.start && e.t <= s.end);
		if (inside.length < 10) {
			out.push(s);
			continue;
		}
		const mean = inside.reduce((a, b) => a + b.e, 0) / inside.length;
		const thresh = mean * SPLIT_DIP_RATIO;
		// group consecutive below-threshold samples into dip runs; each run
		// splits at its end (the onset where vocals pick back up)
		const splits: number[] = [];
		let run: EnergySample[] | null = null;
		for (const e of inside) {
			if (e.e < thresh) {
				if (run) run.push(e);
				else run = [e];
			} else if (run) {
				pushSplit(splits, run, s);
				run = null;
			}
		}
		if (run) pushSplit(splits, run, s);
		let prev = s.start;
		for (const sp of splits) {
			if (sp - prev >= 0.5) {
				out.push({ start: prev, end: sp });
				prev = sp;
			}
		}
		out.push({ start: prev, end: s.end });
	}
	return out;
}

function pushSplit(splits: number[], run: EnergySample[], seg: AlignSegment): void {
	// split at the run's end (onset), but keep it inside the segment
	const sp = Math.min(Math.max(run[run.length - 1].t, seg.start + 0.3), seg.end - 0.3);
	const last = splits[splits.length - 1];
	if (splits.length === 0 || sp - last >= SPLIT_MIN_GAP) splits.push(sp);
}

// skipped lines get interpolated times so the output stays a complete,
// clickable synced lyric list
function fillGaps(times: number[], exp: number[]): void {
	const N = times.length;
	let i = 0;
	while (i < N) {
		if (times[i] >= 0) {
			i++;
			continue;
		}
		let j = i;
		while (j < N && times[j] < 0) j++;
		const prevT = i > 0 ? times[i - 1] : -1;
		const nextT = j < N ? times[j] : -1;
		if (prevT >= 0 && nextT >= 0) {
			const span = Math.max(0, nextT - prevT);
			const total = exp.slice(i, j).reduce((a, b) => a + b, 0) || 1;
			let cum = 0;
			for (let k = i; k < j; k++) {
				times[k] = prevT + (span * cum) / total;
				cum += exp[k];
			}
		} else if (nextT >= 0) {
			// leading run — walk backwards from the first anchored line
			let t = nextT;
			for (let k = j - 1; k >= i; k--) {
				t -= exp[k];
				times[k] = Math.max(0, t);
			}
		} else if (prevT >= 0) {
			// trailing run — continue forward from the last anchored line
			let t = prevT;
			for (let k = i; k < j; k++) {
				t += exp[k];
				times[k] = t;
			}
		}
		i = j;
	}
	for (let k = 1; k < N; k++) {
		if (times[k] < times[k - 1]) times[k] = times[k - 1];
	}
}

// one anchored group: lines [i..i+k) sung over segments [segIdx..segIdx+b)
interface Group {
	lines: number[];
	segIdx: number;
	segCount: number;
}

interface DpResult {
	cost: number;
	fitCost: number; // mismatch + skipped segments — comparable across rates
	groups: Group[];
	segsUsed: number;
}

// typical vocal level of the track: 90th percentile of the raw block
// means — high enough to survive a majority of quiet false segments,
// low enough to ignore a single loud noise burst
export function vocalLevelOf(segs: AlignSegment[], energy: EnergySample[], live = false): number {
	const means: number[] = [];
	for (const s of segs) {
		const inside = energy.filter((e) => e.t >= s.start && e.t <= s.end);
		if (inside.length < 8) continue;
		const mean = inside.reduce((a, b) => a + b.e, 0) / inside.length;
		if (mean > 0) means.push(mean);
	}
	if (!means.length) return Infinity; // nothing to anchor to — judge nothing as quiet
	means.sort((a, b) => a - b);
	const p90 = means[Math.min(means.length - 1, Math.floor(means.length * 0.9))];
	// live degeneracy: before the first real vocal block is heard, the
	// p90 IS the intro-blip level and every blip scores vocal against
	// itself — lines cram onto intro noise and Anchor Locking would
	// freeze the garbage. With few blocks heard, demand contrast: the
	// top must stand clearly above the bottom, else judge nothing vocal
	// (blips get cheap to skip, nothing anchors, nothing locks). Offline
	// the full picture always has the contrast — keep the plain p90
	if (live && means.length < 6) {
		const p25 = means[Math.floor(means.length * 0.25)];
		if (p90 < p25 * 2) return Infinity;
	}
	return p90;
}

// modulation depth of a segment's energy envelope: fraction of samples
// below half the segment mean. Vocals dip between syllables/lines; a
// sustained synth or bass pad doesn't. Two guards before the dip test:
//  - quiet leakage (mean < 40% of the track's typical vocal level) that
//    barely crossed the VAD threshold reads as instrumental at ANY length
//  - short blocks (<6s) are otherwise always vocal: a single sung line
//    often shows no resolvable dips, and skipping real vocals is the
//    costly error — only a LONG flat block reads as instrumental
export function segmentVocalness(seg: AlignSegment, energy: EnergySample[], vocalLevel: number, quietFrac = 0.4): number {
	const inside = energy.filter((e) => e.t >= seg.start && e.t <= seg.end);
	if (inside.length < 8) return 1;
	const mean = inside.reduce((a, b) => a + b.e, 0) / inside.length;
	if (mean <= 0) return 1;
	if (mean < vocalLevel * quietFrac) return 0;
	if (seg.end - seg.start < 6) return 1;
	const dipFrac = inside.filter((e) => e.e < mean * 0.5).length / inside.length;
	// real vocal blocks dip for 10%+ of their time (inter-line pauses);
	// flat leakage sits near zero
	return Math.min(1, dipFrac / 0.1);
}

// core DP over lines [0, nLines) × all segments. exp is the expected sung
// duration per line for ONE rate hypothesis; voc[j] is the vocalness of
// segment j — it prices both leaving it unexplained (skip) and covering it
// with lines (flat-fill penalty)

// lookback gap-excess charged when a group anchors onto segment j: the wall
// gaps immediately before j, after VOCAL segments, beyond the free pause.
// This is the local, recurrence-friendly form of the inter-group gap prior:
// drift accumulates exactly in unexplained wall time after vocal segments.
// Gaps after instrumental segments (voc < 0.5) are inter-blip space — free —
// which keeps intros and legit sparse regions uncharged.
const GAP_LOOKBACK = 3; // segments — how far back the anchor must explain

function lookbackGapExcess(segs: AlignSegment[], voc: number[], j: number, j0 = 0): number {
	let excess = 0;
	for (let x = Math.max(j0, j - GAP_LOOKBACK); x < j; x++) {
		if (x + 1 >= segs.length) continue;
		if (voc[x] < 0.5) continue;
		excess += Math.max(0, segs[x + 1].start - segs[x].end - GAP_FREE);
	}
	return excess;
}

// i0/j0: Anchor Locking boundary — lines [0, i0) and segments [0, j0) are
// frozen; the DP solves only the remainder (план item 4). jEnd: capacity
// cut — segments beyond the admitted lines' plausible reach are future
// lines' material; leaving them in the problem invites the DP to drag
// admitted lines forward to cover them. With i0 = j0 = 0 and jEnd = M
// this is the full-track problem
export function dpSolve(
	exp: number[],
	segs: AlignSegment[],
	voc: number[],
	nLines: number,
	i0 = 0,
	j0 = 0,
	jEnd?: number
): DpResult {
	const N = nLines;
	const M = segs.length;
	const JE = jEnd === undefined ? M : Math.min(jEnd, M);
	// dp[i][j] = min cost of aligning lines [i0, i) with segments [j0, j)
	const INF = Infinity;
	const dp: number[][] = [];
	const di: number[][] = [];
	const dj: number[][] = [];
	for (let i = 0; i <= N; i++) {
		dp.push(new Array<number>(M + 1).fill(INF));
		di.push(new Array<number>(M + 1).fill(0));
		dj.push(new Array<number>(M + 1).fill(0));
	}
	dp[i0][j0] = 0;

	for (let i = i0; i <= N; i++) {
		for (let j = j0; j <= JE; j++) {
			const cur = dp[i][j];
			if (cur === INF) continue;
			// skip line i — undetected vocals
			if (i < N) {
				const c = cur + W_SKIP_LINE * exp[i];
				if (c < dp[i + 1][j]) {
					dp[i + 1][j] = c;
					di[i + 1][j] = 1;
					dj[i + 1][j] = 0;
				}
			}
			// skip segment j — unexplained vocal
			if (j < JE) {
				const c = cur + (W_SKIP_BASE + W_SKIP_VOCAL * voc[j]) * (segs[j].end - segs[j].start);
				if (c < dp[i][j + 1]) {
					dp[i][j + 1] = c;
					di[i][j + 1] = 0;
					dj[i][j + 1] = 1;
				}
			}
			// k lines share segment j — split it proportionally
			if (j < JE) {
				const dur = segs[j].end - segs[j].start;
				const flat = W_FILL_FLAT * (1 - voc[j]) * dur;
				const gapX = W_GAP_EXCESS * lookbackGapExcess(segs, voc, j, j0);
				let sum = 0;
				for (let k = 1; k <= MAX_LINES_PER_SEGMENT && i + k <= N; k++) {
					sum += exp[i + k - 1];
					const c = cur + mismatchCost(dur, sum) + flat + gapX;
					if (c < dp[i + k][j + 1]) {
						dp[i + k][j + 1] = c;
						di[i + k][j + 1] = k;
						dj[i + k][j + 1] = 1;
					}
				}
			}
			// line i spans segments j..j+k−1 (VAD split one line)
			if (i < N && j < JE) {
				const gapX = W_GAP_EXCESS * lookbackGapExcess(segs, voc, j, j0);
				for (let k = 1; k <= MAX_SEGMENTS_PER_LINE && j + k <= JE; k++) {
					const span = segs[j + k - 1].end - segs[j].start;
					let flat = 0;
					for (let x = 0; x < k; x++) flat += W_FILL_FLAT * (1 - voc[j + x]) * (segs[j + x].end - segs[j + x].start);
					const c = cur + mismatchCost(span, exp[i]) + flat + gapX;
					if (c < dp[i + 1][j + k]) {
						dp[i + 1][j + k] = c;
						di[i + 1][j + k] = 1;
						dj[i + 1][j + k] = k;
					}
				}
			}
		}
	}

	// backtrack: collect groups of lines anchored to a segment span
	const groups: Group[] = [];
	let i = N;
	let j = JE;
	let segsUsed = 0;
	while (i > i0 || j > j0) {
		const a = di[i][j];
		const b = dj[i][j];
		if (a === 0 && b === 0) break; // dp[i0][j0] reached
		if (a > 0 && b > 0) {
			const idxs: number[] = [];
			for (let x = i - a; x < i; x++) idxs.push(x);
			groups.push({ lines: idxs, segIdx: j - b, segCount: b });
			segsUsed += b;
		}
		i -= a;
		j -= b;
	}
	groups.reverse();

	// fit cost of the chosen path: mismatch + flat-fill penalties of every
	// anchored group plus the skip price of segments left unexplained.
	// Line-skip costs are excluded — they scale with the rate hypothesis
	// itself and would bias the grid search toward slow rates
	let fit = 0;
	const covered = new Array<boolean>(M).fill(false);
	for (const g of groups) {
		const span = segs[g.segIdx + g.segCount - 1].end - segs[g.segIdx].start;
		const sum = g.lines.reduce((s, idx) => s + exp[idx], 0);
		fit += mismatchCost(span, sum);
		for (let k = 0; k < g.segCount; k++) {
			const idx = g.segIdx + k;
			covered[idx] = true;
			fit += W_FILL_FLAT * (1 - voc[idx]) * (segs[idx].end - segs[idx].start);
		}
	}
	for (let k = j0; k < JE; k++) {
		if (!covered[k]) fit += (W_SKIP_BASE + W_SKIP_VOCAL * voc[k]) * (segs[k].end - segs[k].start);
	}
	// inter-group wall-gap excess: drift accumulates here, nowhere else
	for (let g = 1; g < groups.length; g++) {
		const prevEnd = segs[groups[g - 1].segIdx + groups[g - 1].segCount - 1].end;
		const gap = segs[groups[g].segIdx].start - prevEnd;
		let skippedExp = 0;
		for (let li = groups[g - 1].lines[groups[g - 1].lines.length - 1] + 1; li < groups[g].lines[0]; li++) {
			skippedExp += exp[li];
		}
		fit += W_GAP_EXCESS * Math.max(0, gap - GAP_FREE - skippedExp);
	}
	return { cost: dp[N][JE], fitCost: fit, groups, segsUsed };
}

// ---- Two-Pass DP (план item 7) ----
// Pass 1 (coarse): align line blocks to super-segments. Pass 2 (fine):
// within each block, dpSolve distributes the block's lines over its
// segments with the block's own tempo. The old single-pass solve let
// homogeneous rap drift — "each line its own segment" stays locally cheap
// while the path slides forward — because every individual |span − exp|
// fit is affordable. At block granularity a one-slot shift costs a whole
// block's duration mismatch, and a block holding more lines than segments
// forces sharing in pass 2 — the drift path becomes infeasible.

// one coarse unit: VAD segments [j0, j1) merged across pauses ≤ SUPER_GAP
interface SuperSeg {
	j0: number; // first segment (absolute index)
	j1: number; // one past the last segment (absolute index)
	start: number; // wall start
	end: number; // wall end
	sung: number; // Σ segment durations — wall span minus internal pauses
	voc: number; // duration-weighted vocalness
	dursAsc: number[]; // segment durations ascending — surplus pricing
}

export function buildSupers(segs: AlignSegment[], voc: number[], j0: number, jEnd: number): SuperSeg[] {
	const supers: SuperSeg[] = [];
	for (let j = j0; j < jEnd; j++) {
		const dur = segs[j].end - segs[j].start;
		const last = supers.length - 1;
		if (last >= 0 && segs[j].start - supers[last].end <= SUPER_GAP) {
			const s = supers[last];
			s.j1 = j + 1;
			s.end = segs[j].end;
			s.voc = (s.voc * s.sung + voc[j] * dur) / (s.sung + dur);
			s.sung += dur;
			s.dursAsc.push(dur);
			s.dursAsc.sort((a, b) => a - b);
		} else {
			supers.push({ j0: j, j1: j + 1, start: segs[j].start, end: segs[j].end, sung: dur, voc: voc[j], dursAsc: [dur] });
		}
	}
	return supers;
}

// one pass-1 assignment: lines [i0, i1) sung over the segments of one super
interface Pass1Block {
	i0: number; // first line (absolute)
	i1: number; // one past the last line (absolute)
	j0: number; // super's first segment (absolute)
	j1: number; // one past the super's last segment (absolute)
}

// pass 1: contiguous partition of lines [i0, nLines) over supers — each
// super either takes a run of ≥1 lines or is skipped entirely; no line-skip
// moves (pass 2 skips lines within blocks). Trailing unassigned lines are
// skipped at the final state — vocals not yet heard (live) or genuinely
// unexplained (offline)
export function pass1Solve(
	exp: number[],
	supers: SuperSeg[],
	nLines: number,
	i0: number
): { blocks: Pass1Block[]; cost: number; fitCost: number; assigned: boolean[]; end: number } {
	const S = supers.length;
	const INF = Infinity;
	// dp[u][i][a]: min cost after deciding supers [0, u) with lines [i0, i)
	// assigned; a = 1 once any super has taken lines — silence before the
	// first assignment is intro, free (mirrors dpSolve)
	const dp: number[][][] = [];
	const mv: number[][][] = []; // lines taken by super u−1 on the move into (u, i, a); 0 = skipped
	const pm: number[][][] = []; // predecessor (i, a) packed as i*2+a
	for (let u = 0; u <= S; u++) {
		const d: number[][] = [];
		const m: number[][] = [];
		const p: number[][] = [];
		for (let i = 0; i <= nLines; i++) {
			d.push([INF, INF]);
			m.push([0, 0]);
			p.push([-1, -1]);
		}
		dp.push(d);
		mv.push(m);
		pm.push(p);
	}
	dp[0][i0][0] = 0;
	for (let u = 0; u < S; u++) {
		const sup = supers[u];
		// inter-super silence: wall time between consecutive supers beyond
		// the free pause — charged only once singing has started (a = 1).
		// Per-boundary GAP_FREE errs cheaper than one gap over the whole
		// skipped run — the same locality the old lookbackGapExcess had.
		// Capped at SILENCE_CAP: long breaks are real or undetected vocals,
		// free to jump (the old DP's lookback never saw them either). The
		// take-move credits the gap with the block's underflow (old DP's
		// skippedExp semantics, block-level): the lines pass 2 will skip
		// inside the block sing in the gap BEFORE the block's super —
		// fillGaps seats them between the previous anchor and this block
		const gapExcess = u > 0 ? Math.max(0, sup.start - supers[u - 1].end - GAP_FREE) : 0;
		const silSkip = W_GAP_EXCESS * Math.min(gapExcess, SILENCE_CAP);
		const skipCost = (W_SKIP_BASE + W_SKIP_VOCAL * sup.voc) * sup.sung;
		const flat = W_FILL_FLAT * (1 - sup.voc) * sup.sung;
		const E = sup.j1 - sup.j0;
		for (let i = i0; i <= nLines; i++) {
			for (let a = 0; a < 2; a++) {
				const cur = dp[u][i][a];
				if (cur === INF) continue;
				// skip super u — unexplained vocals
				const c0 = cur + (a === 1 ? silSkip : 0) + skipCost;
				if (c0 < dp[u + 1][i][a]) {
					dp[u + 1][i][a] = c0;
					mv[u + 1][i][a] = 0;
					pm[u + 1][i][a] = i * 2 + a;
				}
				// super u takes lines [i, i+k) — duration match at block level.
				// Capacity cap: pass 2 seats at most MAX_LINES_PER_SEGMENT lines
				// per segment, so a super of E segments can't honestly take more
				// than E×that — without the cap the cheap block-level underflow
				// price (0.35/s) makes one giant cram cheaper than skipping
				// lines (1.0/s), and 59 lines land in one 5s super (игрушка)
				const cap = (sup.j1 - sup.j0) * MAX_LINES_PER_SEGMENT;
				let sum = 0;
				for (let k = 1; i + k <= nLines && k <= cap; k++) {
					sum += exp[i + k - 1];
					// the block's skipped lines explain the gap before it
					const silTake =
						a === 1
							? W_GAP_EXCESS * Math.min(Math.max(0, gapExcess - Math.max(0, sum - sup.sung)), SILENCE_CAP)
							: 0;
					// surplus segs: k lines can't anchor E > k segs
					// one-per-line — the leftovers must be skipped or absorbed
					// by spanning lines; price them at the (optimistic) skip
					// price of the shortest ones. Without this a block
					// under-filled by a whole verse reads as a cheap perfect
					// duration match and the displaced lines drift into
					// later supers
					let sur = 0;
					if (E > k) {
						for (let x = 0; x < E - k; x++) sur += sup.dursAsc[x];
						sur *= W_SKIP_BASE + W_SKIP_VOCAL * sup.voc;
					}
					const c = cur + silTake + mismatchCost(sup.sung, sum) + flat + sur;
					if (c < dp[u + 1][i + k][1]) {
						dp[u + 1][i + k][1] = c;
						mv[u + 1][i + k][1] = k;
						pm[u + 1][i + k][1] = i * 2 + a;
					}
				}
			}
		}
	}
	// close-out: supers [u, S) are skipped WITHOUT silence — a trailing
	// outro is unexplained vocals, not drift; the old DP charged gaps only
	// at anchors, never for the unanchored tail. Trailing lines are skipped
	// at W_SKIP_LINE (vocals not yet heard or genuinely unexplained)
	const suffixSkip = new Array<number>(S + 1).fill(0);
	for (let u = S - 1; u >= 0; u--) {
		suffixSkip[u] = suffixSkip[u + 1] + (W_SKIP_BASE + W_SKIP_VOCAL * supers[u].voc) * supers[u].sung;
	}
	const tailExp = new Array<number>(nLines + 1).fill(0);
	for (let i = nLines - 1; i >= i0; i--) tailExp[i] = tailExp[i + 1] + exp[i];
	let bestCost = Infinity;
	let bestFit = Infinity; // everything except the trailing line skips
	let bu = 0;
	let bi = i0;
	let ba = 0;
	for (let u = 0; u <= S; u++) {
		for (let i = i0; i <= nLines; i++) {
			for (let a = 0; a < 2; a++) {
				const c = dp[u][i][a];
				if (c === Infinity) continue;
				const fit = c + suffixSkip[u];
				const total = fit + W_SKIP_LINE * tailExp[i];
				if (total < bestCost) {
					bestCost = total;
					bestFit = fit;
					bu = u;
					bi = i;
					ba = a;
				}
			}
		}
	}
	if (bestCost === Infinity) return { blocks: [], cost: Infinity, fitCost: Infinity, assigned: [], end: 0 };
	const blocks: Pass1Block[] = [];
	const assigned = new Array<boolean>(S).fill(false);
	let i = bi;
	let a = ba;
	for (let u = bu; u > 0; u--) {
		const k = mv[u][i][a];
		const prev = pm[u][i][a];
		const prevI = Math.floor(prev / 2);
		const prevA = prev % 2;
		if (k > 0) {
			blocks.push({ i0: prevI, i1: i, j0: supers[u - 1].j0, j1: supers[u - 1].j1 });
			assigned[u - 1] = true;
		}
		i = prevI;
		a = prevA;
	}
	blocks.reverse();
	return { blocks, cost: bestCost, fitCost: bestFit, assigned, end: bu };
}

export function alignLyrics(
	linesIn: { text: string }[],
	segments: AlignSegment[],
	trackLength: number,
	energy?: EnergySample[],
	stats?: Partial<AlignStats>,
	now?: number, // live mode: current track position — lines beyond the heard
	// vocal evidence stay unanchored and forward-fill into the future
	lock?: AlignLock | null // live mode: frozen prefix from Anchor Locking — the DP
	// solves only the lines/segments after the lock boundary
): AlignLine[] {
	const lines = linesIn.filter((l) => isAlignable(l.text));
	if (!lines.length) return [];
	const sylls = lines.map((l) => countSyllables(l.text));
	const rawSegs = cleanSegments(segments);
	// vocalness is a property of the RAW block: refined slices are dip-free
	// by construction (they're cut AT the dips), so they must inherit it.
	// The track's typical vocal level (90th percentile of block means —
	// robust against a majority of quiet false segments) anchors the
	// quiet-leakage test
	const level =
		energy && energy.length >= 10 ? vocalLevelOf(rawSegs, energy, now !== undefined) : Infinity;
	const rawVoc =
		energy && energy.length >= 10 ? rawSegs.map((s) => segmentVocalness(s, energy, level)) : null;
	const segs = rawVoc ? refineSegments(rawSegs, energy!) : rawSegs;
	const segVoc = segs.map((s) => {
		if (!rawVoc) return 1; // no envelope — assume vocal
		for (let k = 0; k < rawSegs.length; k++) {
			if (s.start >= rawSegs[k].start - 0.01 && s.start < rawSegs[k].end) {
				return rawVoc[k];
			}
		}
		return 1;
	});
	// lock-strict vocalness: the level estimate only grows as more vocals
	// arrive, so a segment merely above the 0.4 quiet threshold now may be
	// quiet leakage a minute later — Anchor Locking demands a margin
	// (0.5×level) before a segment may freeze a line on it. Not 0.6: the
	// FIRST vocal segments are the track's quietest and sit near 0.55×p90
	// of the final level — a 0.6 margin would make them never lockable
	const segLockVoc = rawVoc
		? segs.map((s) => segmentVocalness(s, energy!, level, 0.5))
		: segs.map(() => 1);
	const N = lines.length;
	const M = segs.length;
	if (stats) {
		stats.anchored = 0;
		stats.interpolated = N;
		stats.segsUsed = 0;
		stats.segsSkipped = M;
		stats.cost = 0;
		stats.rate = MS_PER_SYLLABLE;
		stats.expected = 0;
		stats.refined = segs;
	}

	const times = new Array<number>(N).fill(-1);
	const lineSeg = new Array<number>(N).fill(-1);
	const lineEnd = new Array<number>(N).fill(-1);
	const lineVoc = new Array<number>(N).fill(-1);
	const lineSpan = new Array<number>(N).fill(-1);

	// Anchor Locking: frozen prefix — locked lines keep their times, and
	// the DP below solves only the remainder from (i0, j0)
	let i0 = 0;
	let j0 = 0;
	if (lock && lock.lineIdx >= 0 && lock.lineIdx < N && lock.segIdx < M && lock.times.length > lock.lineIdx) {
		i0 = lock.lineIdx + 1;
		j0 = lock.segIdx + 1;
		for (let i = 0; i <= lock.lineIdx; i++) {
			times[i] = lock.times[i];
			lineSeg[i] = lock.lineSeg[i];
			lineEnd[i] = lock.lineEnd[i];
			lineVoc[i] = lock.lineVoc[i];
		}
	}

	// no vocal evidence at all — spread proportionally over the track
	if (M === 0) {
		const exp = sylls.map((s) => expectedDuration(s));
		const total = exp.reduce((a, b) => a + b, 0) || 1;
		const span = Math.max(trackLength, total);
		let cum = 0;
		for (let i = 0; i < N; i++) {
			times[i] = (cum / total) * span;
			cum += exp[i];
		}
		return lines.map((l, i) => ({ text: l.text, time: roundTime(times[i]) }));
	}

	// live mode: only lines the heard evidence can plausibly explain enter
	// the DP; the rest forward-fill into the unheard future. Without this
	// the DP crams every line into the first segments (all times in the
	// past) and the highlight latches onto the last line. Only VOCAL heard
	// time buys line slots, and only ~one line per segment's worth of it:
	// admitting more (the old ×1.3+3 slack) forces the DP to seat surplus
	// lines on refined slivers — a one-slot-shifted cram that Anchor
	// Locking would freeze before real evidence corrects it. Near the end
	// of the track the clamp is lifted — with (almost) all evidence in,
	// excluding tail lines leaves outro segments unexplained and drags the
	// whole path (the offline problem admits everyone)
	let nLines = N;
	if (now !== undefined && !(trackLength > 0 && now >= trackLength - 5)) {
		const heard = segs.reduce((s, g, idx) => s + (segVoc[idx] >= 0.5 ? g.end - g.start : 0), 0);
		let cum = 0;
		for (let k = 0; k < N; k++) {
			if (cum > heard * 1.15 + 1) {
				nLines = k;
				break;
			}
			cum += expectedDuration(sylls[k]);
		}
		if (nLines < 1) nLines = 1;
	}

	// capacity cut (jEnd): with lines clamped, segments beyond the
	// admitted lines' plausible reach are future lines' material — leaving
	// them in the problem invites the DP to drag admitted lines forward to
	// cover them (the outro-chop drag). Reach = first vocal anchor + the
	// admitted lines' expected sung time (default rate) with rate-search
	// slack
	let jEnd = M;
	if (now !== undefined && nLines < N) {
		let tA = -1;
		for (let j = j0; j < M; j++) {
			if (segVoc[j] >= 0.5) {
				tA = segs[j].start;
				break;
			}
		}
		if (tA >= 0) {
			let cum = 0;
			for (let i = i0; i < nLines; i++) cum += expectedDuration(sylls[i]);
			const reach = tA + cum * 1.3 + 4;
			while (jEnd > j0 && segs[jEnd - 1].start > reach) jEnd--;
		}
	}

	// Two-Pass DP (план item 7): pass 1 pins line blocks to super-segments
	// (coarse, shift-proof), pass 2 aligns lines within each block at the
	// block's own tempo (dynamic rate across the track). exp becomes
	// per-line: each line's expected duration at ITS block's chosen rate
	let groups: Group[] = [];
	let segsUsed = 0;
	let cost = 0;
	let bestRate = MS_PER_SYLLABLE;
	// per-line expected duration at the calibrated prior rate — the
	// Anchor Locking oversized-seg gate must not trust the DP's per-block
	// rate hypothesis (circular: a wrong fast-rate block inflates exp and
	// its own steal looks justified)
	const expPrior = sylls.map((s) => expectedDuration(s));
	const exp = expPrior.slice();
	if (nLines > i0) {
		const supers = buildSupers(segs, segVoc, j0, jEnd);
		if (supers.length > 0) {
			// pass 1 rate grid — selected by fit cost: trailing line skips
			// scale with the rate itself and would bias the grid (same
			// rationale as dpSolve's fitCost)
			let p1: { blocks: Pass1Block[]; cost: number; fitCost: number; assigned: boolean[]; end: number } | null = null;
			for (let rate = RATE_MIN; rate <= RATE_MAX; rate += RATE_STEP) {
				const expR = sylls.map((s) => expectedDuration(s, rate));
				const r = pass1Solve(expR, supers, nLines, i0);
				if (!p1 || r.fitCost < p1.fitCost) {
					p1 = r;
					bestRate = rate;
				}
			}
			if (p1) {
				// pass 2: within each block, distribute its lines over its
				// segments with the block's own tempo
				for (const b of p1.blocks) {
					let best: DpResult | null = null;
					let blockRate = MS_PER_SYLLABLE;
					for (let rate = RATE_MIN; rate <= RATE_MAX; rate += RATE_STEP) {
						const expR = sylls.map((s) => expectedDuration(s, rate));
						const r = dpSolve(expR, segs, segVoc, b.i1, b.i0, b.j0, b.j1);
						if (!best || r.fitCost < best.fitCost) {
							best = r;
							blockRate = rate;
						}
					}
					if (best) {
						groups = groups.concat(best.groups);
						segsUsed += best.segsUsed;
						cost += best.cost;
						for (let i = b.i0; i < b.i1; i++) exp[i] = expectedDuration(sylls[i], blockRate);
					}
				}
				// boundary costs mirroring pass 1's charges: skipped supers'
				// skip price, silence at every decided super boundary except
				// the trailing close-out (unanchored outro pays no silence —
				// old DP semantics). Assigned boundaries get the block's
				// underflow credit (pass 1's silTake), recomputed at the
				// pass-1 rate. Pass-1 assign mismatches are excluded — pass 2
				// already prices what the blocks fit — keeping the normCost
				// scale comparable to the gate (0.45)
				const blockOf = new Map<number, Pass1Block>();
				for (const b of p1.blocks) blockOf.set(supers.findIndex((s) => s.j0 === b.j0), b);
				let assignedBefore = false;
				for (let u = 0; u < supers.length; u++) {
					const sup = supers[u];
					const gapExcess =
						assignedBefore && u > 0
							? Math.max(0, sup.start - supers[u - 1].end - GAP_FREE)
							: 0;
					if (p1.assigned[u]) {
						const b = blockOf.get(u);
						let sum = 0;
						if (b) for (let i = b.i0; i < b.i1; i++) sum += expectedDuration(sylls[i], bestRate);
						cost +=
							W_GAP_EXCESS *
							Math.min(Math.max(0, gapExcess - (b ? Math.max(0, sum - sup.sung) : 0)), SILENCE_CAP);
						assignedBefore = true;
					} else {
						cost += (W_SKIP_BASE + W_SKIP_VOCAL * sup.voc) * sup.sung;
						if (u < p1.end) cost += W_GAP_EXCESS * Math.min(gapExcess, SILENCE_CAP);
					}
				}
			}
		}
	}

	if (stats) {
		stats.anchored = groups.reduce((s, g) => s + g.lines.length, 0);
		for (let i = 0; i < i0; i++) if (lineSeg[i] >= 0) stats.anchored++;
		stats.interpolated = N - stats.anchored;
		stats.segsUsed = segsUsed + j0; // j0 segments are frozen, not skipped
		stats.segsSkipped = M - stats.segsUsed;
		stats.cost = cost;
		stats.rate = bestRate;
		stats.expected = exp.reduce((a, b) => a + b, 0);
		// evidence maturity + normalized cost (план item 6): total DP cost
		// per second of segment evidence the solver had to explain (from
		// the lock boundary on). A cram — lines forced into too little
		// evidence — reads as an expensive fit; Anchor Locking refuses to
		// freeze anything the solver itself considers bad
		stats.rawBlocks = rawSegs.length;
		let evidence = 0;
		for (let j = j0; j < jEnd; j++) evidence += segs[j].end - segs[j].start;
		stats.normCost = cost / Math.max(1, evidence);
	}

	if (!groups.length) {
		if (now !== undefined) {
			if (i0 > 0) {
				// frozen prefix, nothing new anchored yet — forward-fill the
				// unheard future from the locked lines
				fillGaps(times, exp);
				for (let k = 0; k < N; k++) {
					if (lineEnd[k] < 0 && times[k] >= 0) lineEnd[k] = times[k] + exp[k];
				}
				if (stats) {
					stats.lineSeg = lineSeg;
					stats.lineEnd = lineEnd;
					stats.lineVoc = lineVoc;
					stats.lineExp = expPrior;
					stats.lineSpan = lineSpan;
				}
				return lines.map((l, k) => ({ text: l.text, time: roundTime(times[k]) }));
			}
			// live with nothing anchored yet — an honest no-highlight beats
			// a wrong proportional spread over the whole track
			return lines.map((l) => ({ text: l.text, time: -1 }));
		}
		// DP skipped everything (shouldn't happen) — proportional fallback
		const total = exp.reduce((a, b) => a + b, 0) || 1;
		let cum = 0;
		for (let k = 0; k < N; k++) {
			times[k] = (cum / total) * Math.max(trackLength, total);
			cum += exp[k];
		}
		return lines.map((l, k) => ({ text: l.text, time: roundTime(times[k]) }));
	}

	for (const g of groups) {
		const start = segs[g.segIdx].start;
		const end = segs[g.segIdx + g.segCount - 1].end;
		const lastSeg = g.segIdx + g.segCount - 1;
		for (const idx of g.lines) lineSpan[idx] = end - start;
		if (g.lines.length === 1) {
			times[g.lines[0]] = start;
			lineSeg[g.lines[0]] = lastSeg;
			lineEnd[g.lines[0]] = end;
			lineVoc[g.lines[0]] = segLockVoc[lastSeg];
		} else {
			const total = g.lines.reduce((s, idx) => s + exp[idx], 0) || 1;
			let cum = 0;
			for (const idx of g.lines) {
				times[idx] = start + ((end - start) * cum) / total;
				cum += exp[idx];
				lineSeg[idx] = lastSeg;
				lineVoc[idx] = segLockVoc[lastSeg];
			}
			for (let x = 0; x < g.lines.length; x++) {
				lineEnd[g.lines[x]] = x + 1 < g.lines.length ? times[g.lines[x + 1]] : end;
			}
		}
	}

	fillGaps(times, exp);
	// interpolated lines: end = own start + expected duration
	for (let k = 0; k < N; k++) {
		if (lineEnd[k] < 0 && times[k] >= 0) lineEnd[k] = times[k] + exp[k];
	}
	if (stats) {
		stats.lineSeg = lineSeg;
		stats.lineEnd = lineEnd;
		stats.lineVoc = lineVoc;
		stats.lineExp = expPrior;
		stats.lineSpan = lineSpan;
	}
	return lines.map((l, k) => ({ text: l.text, time: roundTime(times[k]) }));
}

// Anchor Locking state machine (план item 4): UNVISITED → ACTIVE → LOCKED.
// A line freezes once the playback position has passed its end by 3s AND
// its binding survived 2 consecutive DP runs unchanged (anchored lines —
// by segment index; interpolated lines — by settled time). Frozen lines
// pin the DP: the highlight can never jump back into played text, and an
// early correct anchor stops phase-shift cascades from propagating.
const LOCK_PASS_S = 3.0; // position must be past the line end by this
const LOCK_STABLE_RUNS = 2; // unchanged binding across this many DP runs
const LOCK_TIME_JITTER = 0.5; // s — interpolated lines freeze only once settled
const LOCK_MIN_VOC = 0.5; // only vocal anchors may freeze — instrumental
// anchors are placeholders the DP re-assigns when real vocals arrive
const LOCK_SPAN_SLACK = 1.0; // s — max unexplained vocal time left in the
// anchor after the line's expected singing ends. A single line frozen on
// a seg holding far more time than it sings steals the seg from the next
// line (which still has to join it) — the lock boundary then pushes every
// later line forward, one stolen seg snowballing into a whole-verse shift
const LOCK_MIN_BLOCKS = 6; // raw VAD blocks before the level estimate is
// mature — below this a "vocal" verdict can still flip as vocals arrive
const LOCK_MAX_NORM_COST = 0.45; // план item 6: DP cost per second of
// evidence — a cram is an expensive fit; freeze nothing the solver hates
const SEEK_JUMP_S = 1.5; // |Δposition − Δwall| beyond this = seek/replay

export class AnchorLocker {
	private lock: AlignLock | null = null;
	private prevSeg: number[] | null = null;
	private prevTimes: number[] | null = null;
	private stable: number[] | null = null;
	private lastPos = -1;
	private lastWall = 0;

	reset(): void {
		this.lock = null;
		this.prevSeg = null;
		this.prevTimes = null;
		this.stable = null;
		this.lastPos = -1;
	}

	// clock tick (track position + wall ms). A position jump not explained
	// by wall time means seek/replay — drop every lock and let the next DP
	// run re-anchor from scratch. A PAUSE (position frozen while wall time
	// advances) is not a seek: the mapping stays valid and the lock must
	// survive until playback resumes (план item 5)
	onClock(position: number, wallMs: number): void {
		if (this.lastPos >= 0) {
			const dPos = position - this.lastPos;
			const dWall = (wallMs - this.lastWall) / 1000;
			if (dPos < -SEEK_JUMP_S || dPos > dWall + SEEK_JUMP_S) this.reset();
		}
		this.lastPos = position;
		this.lastWall = wallMs;
	}

	get current(): AlignLock | null {
		return this.lock;
	}

	// feed the result of a live alignLyrics run; extends the frozen prefix
	// as far as consecutive lines qualify
	update(position: number, aligned: AlignLine[], stats: Partial<AlignStats>): void {
		const lineSeg = stats.lineSeg;
		const lineEnd = stats.lineEnd;
		const lineVoc = stats.lineVoc;
		if (!lineSeg || !lineEnd || !lineVoc || aligned.length !== lineSeg.length) return;
		// evidence maturity: the vocal-level estimate is p90 over heard
		// blocks — with fewer than LOCK_MIN_BLOCKS it is still growing and
		// a "vocal" verdict can flip when real vocals arrive
		if ((stats.rawBlocks ?? 0) < LOCK_MIN_BLOCKS) return;
		// cost confidence: lines crammed into too little evidence read as
		// an expensive fit — freeze nothing the solver itself hates
		if (stats.normCost === undefined || stats.normCost > LOCK_MAX_NORM_COST) return;
		const N = lineSeg.length;
		if (!this.stable || this.stable.length !== N) {
			this.stable = new Array<number>(N).fill(0);
			this.prevSeg = null;
			this.prevTimes = null;
		}
		const base = this.lock ? this.lock.lineIdx : -1;
		for (let i = base + 1; i < N; i++) {
			if (lineSeg[i] >= 0 && this.prevSeg && this.prevSeg[i] === lineSeg[i]) {
				this.stable[i] = (this.stable[i] || 0) + 1;
			} else {
				this.stable[i] = lineSeg[i] >= 0 ? 1 : 0;
			}
		}
		const prevTimes = this.prevTimes;
		const timesNow = aligned.map((l) => l.time);
		// extend the frozen prefix: every line up to the new boundary must
		// be past playback (+3s) and settled — anchored lines by segment
		// stability ON A VOCAL SEGMENT (an instrumental anchor is a
		// placeholder the DP will re-assign once real vocals arrive —
		// freezing it would freeze a guess), interpolated lines by time
		// stability
		let L = base;
		for (let i = base + 1; i < N; i++) {
			const end = lineEnd[i];
			if (end < 0 || position <= end + LOCK_PASS_S) break;
			if (lineSeg[i] >= 0) {
				// a SHARED segment (several lines in one group) is split
				// proportionally — a guess the DP re-splits as evidence
				// grows; it must not freeze
				if (i > 0 && lineSeg[i] === lineSeg[i - 1]) break;
				if (lineVoc[i] < LOCK_MIN_VOC) break;
				// an anchor seg holding far more time than the line sings
				// still owes singing time to the NEXT line — freezing the
				// line alone would steal the seg and shift the whole
				// remainder forward (see LOCK_SPAN_SLACK)
				const span = stats.lineSpan?.[i] ?? -1;
				const exp = stats.lineExp?.[i] ?? -1;
				if (span >= 0 && exp >= 0 && span > exp + LOCK_SPAN_SLACK) break;
				if (this.stable[i] < LOCK_STABLE_RUNS) break;
			} else {
				const t = timesNow[i];
				const p = prevTimes ? prevTimes[i] : -1;
				if (t < 0 || p < 0 || Math.abs(t - p) > LOCK_TIME_JITTER) break;
			}
			L = i;
		}
		this.prevSeg = lineSeg;
		this.prevTimes = timesNow;
		if (L > base) {
			// a prefix without a single vocal anchor is pure interpolation
			// (proportional spread / backward extrapolation) — nothing to
			// pin the times to, don't freeze it
			let segIdx = -1;
			let vocalAnchor = false;
			for (let i = 0; i <= L; i++) {
				if (lineSeg[i] > segIdx) segIdx = lineSeg[i];
				if (lineSeg[i] >= 0 && lineVoc[i] >= LOCK_MIN_VOC) vocalAnchor = true;
			}
			if (!vocalAnchor) return;
			this.lock = {
				lineIdx: L,
				segIdx,
				times: timesNow.slice(0, L + 1),
				lineSeg: lineSeg.slice(0, L + 1),
				lineEnd: lineEnd.slice(0, L + 1),
				lineVoc: lineVoc.slice(0, L + 1)
			};
		}
	}
}
