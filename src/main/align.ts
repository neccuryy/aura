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
const W_MISMATCH = 1.0; // |segment span − expected sung duration|
const W_SKIP_SEGMENT = 1.2; // vocal time the lyrics don't explain
const W_SKIP_LINE = 1.5; // expected line time the vocal evidence doesn't cover

export function countSyllables(text: string): number {
	const groups = text.toLowerCase().match(VOWELS);
	return groups ? groups.length : 0;
}

function expectedDuration(syllables: number): number {
	return Math.max((syllables * MS_PER_SYLLABLE) / 1000, MIN_LINE_DURATION);
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

// monotonic, non-degenerate segment list: sorted, overlaps merged
function cleanSegments(segs: AlignSegment[]): AlignSegment[] {
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

function refineSegments(segs: AlignSegment[], energy: EnergySample[]): AlignSegment[] {
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

export function alignLyrics(
	linesIn: { text: string }[],
	segments: AlignSegment[],
	trackLength: number,
	energy?: EnergySample[]
): AlignLine[] {
	const lines = linesIn.filter((l) => isAlignable(l.text));
	if (!lines.length) return [];
	const exp = lines.map((l) => expectedDuration(countSyllables(l.text)));
	let segs = cleanSegments(segments);
	if (energy && energy.length) segs = refineSegments(segs, energy);
	const N = lines.length;
	const M = segs.length;

	const times = new Array<number>(N).fill(-1);

	// no vocal evidence at all — spread proportionally over the track
	if (M === 0) {
		const total = exp.reduce((a, b) => a + b, 0) || 1;
		const span = Math.max(trackLength, total);
		let cum = 0;
		for (let i = 0; i < N; i++) {
			times[i] = (cum / total) * span;
			cum += exp[i];
		}
		return lines.map((l, i) => ({ text: l.text, time: roundTime(times[i]) }));
	}

	// dp[i][j] = min cost of aligning lines [0, i) with segments [0, j)
	const INF = Infinity;
	const dp: number[][] = [];
	const di: number[][] = [];
	const dj: number[][] = [];
	for (let i = 0; i <= N; i++) {
		dp.push(new Array<number>(M + 1).fill(INF));
		di.push(new Array<number>(M + 1).fill(0));
		dj.push(new Array<number>(M + 1).fill(0));
	}
	dp[0][0] = 0;

	for (let i = 0; i <= N; i++) {
		for (let j = 0; j <= M; j++) {
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
			if (j < M) {
				const c = cur + W_SKIP_SEGMENT * (segs[j].end - segs[j].start);
				if (c < dp[i][j + 1]) {
					dp[i][j + 1] = c;
					di[i][j + 1] = 0;
					dj[i][j + 1] = 1;
				}
			}
			// k lines share segment j — split it proportionally
			if (j < M) {
				const dur = segs[j].end - segs[j].start;
				let sum = 0;
				for (let k = 1; k <= MAX_LINES_PER_SEGMENT && i + k <= N; k++) {
					sum += exp[i + k - 1];
					const c = cur + W_MISMATCH * Math.abs(dur - sum);
					if (c < dp[i + k][j + 1]) {
						dp[i + k][j + 1] = c;
						di[i + k][j + 1] = k;
						dj[i + k][j + 1] = 1;
					}
				}
			}
			// line i spans segments j..j+k−1 (VAD split one line)
			if (i < N) {
				for (let k = 1; k <= MAX_SEGMENTS_PER_LINE && j + k <= M; k++) {
					const span = segs[j + k - 1].end - segs[j].start;
					const c = cur + W_MISMATCH * Math.abs(span - exp[i]);
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
	const groups: { lines: number[]; start: number; end: number }[] = [];
	let i = N;
	let j = M;
	while (i > 0 || j > 0) {
		const a = di[i][j];
		const b = dj[i][j];
		if (a === 0 && b === 0) break; // dp[0][0] reached
		if (a > 0 && b > 0) {
			const idxs: number[] = [];
			for (let x = i - a; x < i; x++) idxs.push(x);
			groups.push({
				lines: idxs,
				start: segs[j - b].start,
				end: segs[j - 1].end
			});
		}
		i -= a;
		j -= b;
	}
	groups.reverse();

	if (!groups.length) {
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
		if (g.lines.length === 1) {
			times[g.lines[0]] = g.start;
		} else {
			const total = g.lines.reduce((s, idx) => s + exp[idx], 0) || 1;
			let cum = 0;
			for (const idx of g.lines) {
				times[idx] = g.start + ((g.end - g.start) * cum) / total;
				cum += exp[idx];
			}
		}
	}

	fillGaps(times, exp);
	return lines.map((l, k) => ({ text: l.text, time: roundTime(times[k]) }));
}
