// Sprint A benchmark stand (план v2): decode local mp3s, run the REAL
// production pipeline (VoiceIsolator -> VadSegmenter -> alignLyrics from
// dist/main), score the timings against ground truth, and break the error
// down by failure class. Any algorithm change must be followed by a run
// of this script — a change without a number is not an improvement.
//
// Corpus: musicFolders from the app's config.json, scanned recursively.
// Ground truth: a hand-synced .lrc next to the mp3; if absent, a synced
// version is fetched from Lrclib once and cached in .benchmark/truth/.
//
// Usage:
//   node benchmark.js            — run the whole corpus
//   node benchmark.js <filter>   — only tracks whose file name contains <filter>
//   node benchmark.js --compare  — diff the two latest saved runs
//
// Results are saved to .benchmark/runs/<timestamp>.json.

const { MPEGDecoder } = require("mpg123-decoder");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const musicMetadata = require("music-metadata");
const { VocalPipeline } = require("./dist/main/dsp.js");
const { alignLyrics } = require("./dist/main/align.js");

const CHUNK_SEC = 0.05; // the native addon polls at 50ms — mirror it
const CACHE_DIR = path.join(__dirname, ".benchmark");
const TRUTH_DIR = path.join(CACHE_DIR, "truth");
const RUNS_DIR = path.join(CACHE_DIR, "runs");
const USER_AGENT = "aura-benchmark/0.1 (https://github.com/aura-app)";

// ---------- corpus ----------

function musicFolders() {
	try {
		const cfg = JSON.parse(
			fs.readFileSync(path.join(os.homedir(), "AppData", "Roaming", "aura", "config.json"), "utf8")
		);
		return Array.isArray(cfg.musicFolders) ? cfg.musicFolders : [];
	} catch (_e) {
		return [];
	}
}

function walk(dir, out) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (_e) {
		return;
	}
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) walk(full, out);
		else if (e.name.toLowerCase().endsWith(".mp3")) out.push(full);
	}
}

// ---------- ground truth ----------

function parseLrcText(text) {
	const out = [];
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
		if (!m) continue;
		const t = m[3].trim();
		if (!t || /^\[.+\]$/.test(t)) continue; // same filter alignLyrics applies
		out.push({ text: t, time: (+m[1]) * 60 + +m[2] });
	}
	return out;
}

function fetchJson(url, redirects = 0) {
	return new Promise((resolve) => {
		if (redirects > 5) return resolve(null);
		const req = https.get(url, { timeout: 8000, headers: { "User-Agent": USER_AGENT } }, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume();
				return resolve(fetchJson(new URL(res.headers.location, url).toString(), redirects + 1));
			}
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (body += c));
			res.on("end", () => {
				try {
					resolve({ status: res.statusCode || 0, data: JSON.parse(body) });
				} catch (_e) {
					resolve({ status: res.statusCode || 0, data: null });
				}
			});
		});
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(null));
	});
}

// a synced Lrclib record for this track, or null. Duration and artist are
// verified the same way the production lookup does.
async function lrclibTruth(title, artist, duration) {
	const params = new URLSearchParams({ track_name: title });
	if (artist) params.set("artist_name", artist);
	if (duration) params.set("duration", String(Math.round(duration)));
	const get = await fetchJson(`https://lrclib.net/api/get?${params}`);
	if (get && get.status === 200 && get.data && get.data.syncedLyrics && !get.data.instrumental) {
		if (duration && get.data.duration && Math.abs(get.data.duration - duration) > 15) return null;
		return get.data.syncedLyrics;
	}
	const search = await fetchJson(`https://lrclib.net/api/search?${params}`);
	if (search && search.status === 200 && Array.isArray(search.data)) {
		for (const rec of search.data) {
			if (!rec.syncedLyrics || rec.instrumental) continue;
			if (duration && rec.duration && Math.abs(rec.duration - duration) > 15) continue;
			return rec.syncedLyrics;
		}
	}
	return null;
}

// local .lrc next to the mp3 wins (hand-synced beats Lrclib); otherwise a
// cached Lrclib fetch; otherwise fetch now and cache
async function groundTruth(mp3, meta) {
	const local = mp3.replace(/\.mp3$/i, ".lrc");
	if (fs.existsSync(local)) {
		const lines = parseLrcText(fs.readFileSync(local, "utf8"));
		if (lines.length >= 4) return { lines, source: "local" };
	}
	const key = require("crypto")
		.createHash("md5")
		.update(`${meta.artist || ""}|${meta.title || ""}|${Math.round(meta.duration || 0)}`)
		.digest("hex");
	const cached = path.join(TRUTH_DIR, `${key}.lrc`);
	if (fs.existsSync(cached)) {
		const lines = parseLrcText(fs.readFileSync(cached, "utf8"));
		if (lines.length >= 4) return { lines, source: "lrclib" };
	}
	if (!meta.title) return null; // nothing to query with
	const synced = await lrclibTruth(meta.title, meta.artist, meta.duration);
	if (!synced) return null;
	fs.mkdirSync(TRUTH_DIR, { recursive: true });
	fs.writeFileSync(cached, synced);
	const lines = parseLrcText(synced);
	return lines.length >= 4 ? { lines, source: "lrclib" } : null;
}

// ---------- pipeline (mirrors the live loopback path exactly) ----------

function runPipeline(pcm, channels, sampleRate) {
	const frames = pcm.length / channels;
	const chunkFrames = Math.round(sampleRate * CHUNK_SEC);
	const pipeline = new VocalPipeline(sampleRate);
	const segments = [];
	const energy = [];
	let totalFrames = 0;
	for (let off = 0; off < frames; off += chunkFrames) {
		const n = Math.min(chunkFrames, frames - off);
		const chunk = pcm.subarray(off * channels, (off + n) * channels);
		const tStart = totalFrames / sampleRate;
		totalFrames += n;
		const res = pipeline.onChunk(chunk, channels, n, tStart);
		for (const e of res.energy) energy.push(e);
		if (res.segment) segments.push(res.segment);
	}
	const tail = pipeline.flush();
	if (tail) segments.push(tail);
	return { segments, energy, duration: totalFrames / sampleRate };
}

async function decodeMp3(file) {
	// fresh decoder per track: a reused MPEGDecoder leaks internal state
	// across files (decode time balloons and corrupts timing)
	const decoder = new MPEGDecoder();
	await decoder.ready;
	const pcm = await decoder.decode(new Uint8Array(fs.readFileSync(file)));
	decoder.free();
	const channels = pcm.channelData.length;
	const n = pcm.channelData[0].length;
	const interleaved = new Float32Array(n * channels);
	for (let c = 0; c < channels; c++)
		for (let i = 0; i < n; i++) interleaved[i * channels + c] = pcm.channelData[c][i];
	return { pcm: interleaved, channels, sampleRate: pcm.sampleRate };
}

// ---------- scoring ----------

// error classes (план v2): a line may fall into several — each class is
// counted and averaged independently
function classify(aligned, truth, lineSeg) {
	const n = aligned.length;
	const errs = aligned.map((l, i) => l.time - truth[i].time);
	const classes = {
		interpolated: { count: 0, absSum: 0 }, // no VAD anchor at all
		crammed: { count: 0, absSum: 0 },      // 4+ lines share one segment
		drift: { count: 0, absSum: 0 },        // error grows along the track
		tailShift: { count: 0, absSum: 0 }     // last lines pushed far late
	};
	const segLines = new Map();
	for (const s of lineSeg) if (s >= 0) segLines.set(s, (segLines.get(s) || 0) + 1);
	// drift: mean |err| over the last third vs the first, with a consistent
	// sign late in the track
	const third = Math.max(1, Math.floor(n / 3));
	let firstAbs = 0, lastAbs = 0, lastPos = 0, lastNeg = 0;
	for (let i = 0; i < n; i++) {
		if (i < third) firstAbs += Math.abs(errs[i]);
		if (i >= n - third) {
			lastAbs += Math.abs(errs[i]);
			if (errs[i] > 0) lastPos++;
			else if (errs[i] < 0) lastNeg++;
		}
	}
	firstAbs /= third;
	lastAbs /= third;
	const driftTrack = lastAbs > 2 * Math.max(firstAbs, 0.25) && Math.max(lastPos, lastNeg) > third * 0.7;
	for (let i = 0; i < n; i++) {
		const abs = Math.abs(errs[i]);
		if (lineSeg[i] === undefined || lineSeg[i] < 0) {
			classes.interpolated.count++;
			classes.interpolated.absSum += abs;
		}
		const seg = lineSeg[i];
		if (seg !== undefined && seg >= 0 && (segLines.get(seg) || 0) >= 4) {
			classes.crammed.count++;
			classes.crammed.absSum += abs;
		}
		if (driftTrack && i >= third) {
			classes.drift.count++;
			classes.drift.absSum += abs;
		}
		if (i >= n * 0.8 && errs[i] > 2) {
			classes.tailShift.count++;
			classes.tailShift.absSum += abs;
		}
	}
	return { errs, classes, driftTrack };
}

function fmtClass(c) {
	if (!c.count) return "0";
	return `${c.count} (mae ${((c.absSum / c.count) * 1000).toFixed(0)}ms)`;
}

// ---------- main ----------

async function runBenchmark(filter) {
	const folders = musicFolders();
	if (!folders.length) {
		console.log("no musicFolders in config — add folders in the app settings first");
		return;
	}
	const mp3s = [];
	for (const f of folders) walk(f, mp3s);
	const selected = mp3s.filter((f) => !filter || path.basename(f).includes(filter));
	console.log(`corpus: ${selected.length}/${mp3s.length} mp3 files from ${folders.length} folders\n`);

	const tracks = [];
	let totalAbs = 0, totalCount = 0, totalWithin = 0;
	let skipped = 0;
	for (const mp3 of selected) {
		const name = path.basename(mp3);
		let meta = { title: "", artist: "", duration: 0 };
		try {
			const m = await musicMetadata.parseFile(mp3, { duration: false });
			meta = {
				title: m.common.title || "",
				artist: m.common.artist || m.common.albumartist || "",
				duration: (m.format && m.format.duration) || 0
			};
		} catch (_e) { /* tags unreadable — filename only */ }
		const truth = await groundTruth(mp3, meta);
		if (!truth) {
			skipped++;
			continue;
		}
		let decoded;
		try {
			decoded = await decodeMp3(mp3);
		} catch (e) {
			console.log(`${name}: decode failed (${e.message}) — skipped`);
			skipped++;
			continue;
		}
		const { segments, energy, duration } = runPipeline(decoded.pcm, decoded.channels, decoded.sampleRate);
		const stats = {};
		const aligned = alignLyrics(
			truth.lines.map((l) => ({ text: l.text })), segments, duration, energy, stats
		);
		if (aligned.length !== truth.lines.length) {
			console.log(`${name}: LINE MISMATCH aligned ${aligned.length} vs truth ${truth.lines.length} — skipped`);
			skipped++;
			continue;
		}
		let abs = 0, within = 0;
		for (let i = 0; i < truth.lines.length; i++) {
			const d = Math.abs(aligned[i].time - truth.lines[i].time);
			abs += d;
			if (d <= 0.5) within++;
		}
		const { classes, driftTrack } = classify(aligned, truth.lines, stats.lineSeg || []);
		const mae = abs / truth.lines.length;
		totalAbs += abs;
		totalCount += truth.lines.length;
		totalWithin += within;
		tracks.push({
			file: name,
			truthSource: truth.source,
			lines: truth.lines.length,
			mae,
			within500: within / truth.lines.length,
			classes: Object.fromEntries(
				Object.entries(classes).map(([k, v]) => [k, { count: v.count, mae: v.count ? v.absSum / v.count : 0 }])
			),
			driftTrack,
			rate: stats.rate,
			anchored: stats.anchored,
			segsUsed: stats.segsUsed,
			segsSkipped: stats.segsSkipped,
			rawSegments: segments.length,
			duration
		});
		console.log(
			`${name}: MAE ${(mae * 1000).toFixed(0)}ms, ≤500ms ${((within / truth.lines.length) * 100).toFixed(0)}% (${truth.source})` +
			` | interp ${fmtClass(classes.interpolated)}, cram ${fmtClass(classes.crammed)}` +
			`, drift ${fmtClass(classes.drift)}${driftTrack ? "!" : ""}, tail ${fmtClass(classes.tailShift)}` +
			` | rate ${stats.rate}, anchored ${stats.anchored}/${truth.lines.length}, segs ${stats.segsUsed}+${stats.segsSkipped} of ${segments.length}`
		);
	}

	if (!totalCount) {
		console.log("\nnothing scored — corpus empty or all tracks skipped");
		return;
	}
	const overall = {
		tracks: tracks.length,
		skipped,
		lines: totalCount,
		mae: totalAbs / totalCount,
		within500: totalWithin / totalCount
	};
	console.log("=".repeat(90));
	console.log(
		`OVERALL: MAE ${(overall.mae * 1000).toFixed(0)}ms, ≤500ms ${(overall.within500 * 100).toFixed(1)}%` +
		` — ${overall.tracks} tracks, ${overall.lines} lines, ${skipped} skipped`
	);

	fs.mkdirSync(RUNS_DIR, { recursive: true });
	const run = { timestamp: new Date().toISOString(), overall, tracks };
	const file = path.join(RUNS_DIR, `${run.timestamp.replace(/[:.]/g, "-")}.json`);
	fs.writeFileSync(file, JSON.stringify(run, null, "\t"));
	console.log(`saved: ${file}`);
}

function compareRuns() {
	const runs = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).sort();
	if (runs.length < 2) {
		console.log("need at least two saved runs to compare");
		return;
	}
	const prev = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, runs[runs.length - 2]), "utf8"));
	const cur = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, runs[runs.length - 1]), "utf8"));
	const p = new Map(prev.tracks.map((t) => [t.file, t]));
	console.log(`compare: ${runs[runs.length - 2]}  →  ${runs[runs.length - 1]}\n`);
	for (const t of cur.tracks) {
		const o = p.get(t.file);
		if (!o) {
			console.log(`${t.file}: NEW — MAE ${(t.mae * 1000).toFixed(0)}ms`);
			continue;
		}
		const d = (t.mae - o.mae) * 1000;
		const arrow = d < -25 ? "↓" : d > 25 ? "↑" : "=";
		console.log(
			`${t.file}: MAE ${(o.mae * 1000).toFixed(0)} → ${(t.mae * 1000).toFixed(0)}ms (${arrow}${Math.abs(d).toFixed(0)})` +
			`, ≤500ms ${(o.within500 * 100).toFixed(0)} → ${(t.within500 * 100).toFixed(0)}%`
		);
	}
	const d = (cur.overall.mae - prev.overall.mae) * 1000;
	console.log("=".repeat(90));
	console.log(
		`OVERALL: MAE ${(prev.overall.mae * 1000).toFixed(0)} → ${(cur.overall.mae * 1000).toFixed(0)}ms` +
		` (${d < -25 ? "↓" : d > 25 ? "↑" : "="}${Math.abs(d).toFixed(0)}), ≤500ms ` +
		`${(prev.overall.within500 * 100).toFixed(1)} → ${(cur.overall.within500 * 100).toFixed(1)}%`
	);
}

async function main() {
	const arg = process.argv[2] || "";
	if (arg === "--compare") {
		compareRuns();
		return;
	}
	await runBenchmark(arg);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
