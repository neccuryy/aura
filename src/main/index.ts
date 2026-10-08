import { app, BrowserWindow, dialog, ipcMain, crashReporter, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import type { Update, Capabilities } from "winplayer-node";
import { MediaWatcher } from "./watcher";
import { initUpdater } from "./updater";
import { loadConfig, saveConfig, AuraConfig } from "./config";
import { buildIndex, findTrack, LibraryIndex } from "./library";
import { parseLrc, decodeLrcBuffer } from "./lrc";
import { extractPalette } from "./palette";
import { getFallbackCover, artWidth } from "./cover";
import { lookupLyrics, pursueLrclib, pursueGenius, verifyLrclib, clearLyricsCache, saveAlignedLyrics, lyricsCacheStats, clearAllLyricsCache } from "./lrclib";
import { startLoopback, stopLoopback, beginTrack, noteTrackPosition, getTrackSegments, getTrackEnergy, checkLoopbackWatchdog } from "./loopback";
import { alignLyrics, AlignStats, AnchorLocker } from "./align";

interface TrackPayload {
	empty: boolean;
	title?: string;
	artist?: string;
	album?: string;
	appName?: string;
	status?: string;
	capabilities?: Capabilities;
	length?: number;
	artUrl?: string | null;
	palette?: Record<string, string | undefined> | null;
	lyrics?: { lines: { text: string; time: number }[]; synchronized: boolean; instrumental?: boolean } | null;
	lrcSource?: string | null;
	libraryEmpty?: boolean;
}

let win: BrowserWindow | null = null;
let watcher: MediaWatcher | null = null;
let config: AuraConfig = { musicFolders: [], seenApps: [] };
let index: LibraryIndex = { tracks: [], indexedAt: 0 };

let lastTrackId: string | null = null;
let lastStatus: string | null = null;
let trackLength = 0;
let lyricsLookupDuration = 0;    // duration the online lyrics lookup went out with
let lyricsDurationFixed = false; // only one duration-correction relaunch per track
let lyricsFromLrclib = false;    // what's on screen came from Lrclib — nothing to upgrade
let nullStreak = 0;          // consecutive empty updates (sessions can flap)
let artDeliveredFor: string | null = null; // track id whose artwork is on screen
let coverDeadline = 0;       // when a fallback fetch may start (SMTC art gets priority)
let coverJobToken = 0;       // bumped to cancel stale fallback fetches
let fallbackLaunchedFor: string | null = null;
let hiResLaunchedFor: string | null = null; // track id whose hi-res upgrade is in flight
let lyricsLaunchedFor: string | null = null; // track id whose Lrclib lookup is in flight
let lyricsJobToken = 0;       // bumped to cancel stale Lrclib lookups
let lastTrackTitle: string | undefined;   // for the "wrong lyrics" cache reset
let lastTrackArtist: string | undefined;

// Stage 2 (dev-only, loopback-gated): live alignment of plain lyrics.
// When the only available lyrics are plain text, VAD vocal segments are
// matched to lines via DP and a synced version is re-sent to the renderer
// as evidence accumulates; on track end the result is cached so the next
// play starts synced (never overwriting a real synced verdict).
let alignLines: { text: string }[] | null = null; // plain lines being aligned
let alignSource: string | null = null;            // where the plain text came from
let alignCacheable = false;   // online-sourced — the aligned result may be cached
let alignSyncedSeen = false;  // a synced version was delivered — alignment off
let alignLastRun = 0;         // throttle for live re-alignment
let alignLastPos = -1;        // position of the last DP run (pause skip)
let alignMaxPos = 0;          // furthest SMTC position seen while aligning —
                              // completion metric of the cache quality gate

// Anchor Locking (план item 4): passed lines with a stable segment binding
// freeze — later DP runs solve only the remainder, so the highlight never
// jumps back into played text
const alignLocker = new AnchorLocker();

const ALIGN_INTERVAL = 5000;      // ms between live re-alignments
const ALIGN_MIN_SEGMENTS = 1;     // live: energy-dip splitting supplies the
                                  // granularity — one raw VAD block is enough
const ALIGN_CACHE_SEGMENTS = 3;   // cache: minimum evidence to persist

// Source switcher ("< AURA >"): every lyrics source discovered for the
// current track (local .lrc, Lrclib, Genius, live/cached "aura" alignment)
// is registered here and offered to the renderer; a manual selection owns
// the screen until the track changes — automatic updates (late Lrclib
// upgrades, live alignment ticks) only refresh the candidate list then.
interface SourceEntry {
	id: string;          // "local" | "Lrclib" | "Genius" | "aura"
	name: string;        // badge label (file name for a local .lrc)
	status: "pending" | "ready";
	synchronized: boolean;
	instrumental?: boolean;
	lines: { text: string; time: number }[] | null; // null while pending
}
let sourceEntries: SourceEntry[] = [];
let sourcesSettled = false;        // initial search finished — arrows may show
let manualSource: string | null = null; // user-forced display, until track change
let autoSourceId: string | null = null; // what the automatic flow last displayed

function resetSources(): void {
	sourceEntries = [];
	sourcesSettled = false;
	manualSource = null;
	autoSourceId = null;
	broadcastSources();
}

function upsertSource(entry: SourceEntry): void {
	const i = sourceEntries.findIndex((s) => s.id === entry.id);
	if (i >= 0) sourceEntries[i] = entry;
	else sourceEntries.push(entry);
	broadcastSources();
}

// stopAlignment kills the live "aura" source — any pending or ready entry
// (a ready one can be stale: a retry replaced the text it was aligned to).
// A cached "aura" verdict is upserted AFTER stopAlignment, so it survives.
function dropAuraSource(): void {
	const i = sourceEntries.findIndex((s) => s.id === "aura");
	if (i < 0) return;
	sourceEntries.splice(i, 1);
	if (manualSource === "aura") manualSource = null;
	broadcastSources();
}

function broadcastSources(): void {
	if (!win || win.isDestroyed()) return;
	win.webContents.send("sources", {
		entries: sourceEntries.map((s) => ({
			id: s.id,
			name: s.name,
			status: s.status,
			synchronized: s.synchronized
		})),
		current: manualSource || autoSourceId,
		settled: sourcesSettled
	});
}

// gated "lyrics" send: with a manual selection active, an automatic update
// for a DIFFERENT source must not steal the screen (an update for the
// selected source — e.g. live aura ticks while "aura" is selected — flows)
function displayLyricsEvent(id: string | null, source: string | null, lyrics: TrackPayload["lyrics"]): void {
	if (manualSource && id !== manualSource) return;
	if (id) autoSourceId = id;
	if (!win || win.isDestroyed()) return;
	win.webContents.send("lyrics", { lyrics, source });
}

function enterAlignment(lines: { text: string }[], source: string, cacheable: boolean): void {
	alignLines = lines;
	alignSource = source;
	alignCacheable = cacheable;
	alignLastRun = 0;
	alignLastPos = -1;
	alignMaxPos = 0;
	alignLocker.reset();
	// the live alignment is a switchable source — pending until its first
	// output, ready from then on
	upsertSource({ id: "aura", name: "aura", status: "pending", synchronized: false, lines: null });
}

function stopAlignment(): void {
	alignLines = null;
	alignSource = null;
	alignCacheable = false;
	alignLocker.reset();
	dropAuraSource();
}

// track ended (switch or stop) — persist the alignment if it's worth
// anything. Must run BEFORE the old track's title/segments are reset.
function finalizeAlignment(): void {
	const lines = alignLines;
	const source = alignSource;
	const cacheable = alignCacheable;
	stopAlignment();
	if (!lines || !cacheable || alignSyncedSeen || !lastTrackTitle) return;
	const segs = getTrackSegments();
	if (segs.length < ALIGN_CACHE_SEGMENTS) {
		console.log(`[align] "${lastTrackTitle}" — ${segs.length} segments, too little evidence to cache`);
		return;
	}
	const stats: Partial<AlignStats> = {};
	const aligned = alignLyrics(lines, segs, trackLength, getTrackEnergy(), stats);
	if (aligned.length < 3) return;
	// quality gate (план item 6): a garbage alignment must never poison the
	// cache for every future play of the track. Each metric rejects a known
	// failure mode: completion — a partial listen (position never reached
	// the end) produces cram-and-drift garbage; vocal coverage — heard vocal
	// time vs expected sung time (a dead WASAPI capture starves it while the
	// position still advances); anchored — lines backed by real VAD
	// segments, not interpolation; normCost — DP cost per second of
	// evidence; duration — no anomalously short/long lines; monotone —
	// start times strictly rise
	const heard = segs.reduce((s, g) => s + (g.end - g.start), 0);
	const completion = trackLength > 0 ? alignMaxPos / trackLength : 1;
	const vocalCoverage = stats.expected ? heard / stats.expected : 1;
	const anchoredFrac = aligned.length ? (stats.anchored ?? 0) / aligned.length : 0;
	const normCost = stats.normCost ?? Infinity;
	let durationOk = true;
	let monotoneOk = true;
	for (let k = 0; k < aligned.length; k++) {
		const d = (stats.lineEnd?.[k] ?? -1) - aligned[k].time;
		if (d >= 0 && (d < 0.6 || d > 12.0)) durationOk = false;
		if (k > 0 && aligned[k].time <= aligned[k - 1].time) monotoneOk = false;
	}
	if (
		completion < 0.88 || vocalCoverage < 0.4 || anchoredFrac < 0.8 ||
		normCost > 0.45 || !durationOk || !monotoneOk
	) {
		console.log(
			`[align] "${lastTrackTitle}" — quality gate: completion ${(completion * 100).toFixed(0)}%, vocal coverage ${(vocalCoverage * 100).toFixed(0)}%, anchored ${(anchoredFrac * 100).toFixed(0)}%, normCost ${normCost === Infinity ? "n/a" : normCost.toFixed(2)}, duration ${durationOk ? "ok" : "bad"}, monotone ${monotoneOk ? "ok" : "bad"} — not cached`
		);
		return;
	}
	const wrote = saveAlignedLyrics(lastTrackArtist || undefined, lastTrackTitle, aligned);
	if (wrote) {
		console.log(`[align] "${lastTrackTitle}" — cached ${aligned.length} synced lines (${source})`);
	} else {
		console.log(`[align] "${lastTrackTitle}" — kept existing synced cache, local alignment discarded`);
	}
	console.log(`[align] cache stats: rate ${stats.rate} ms/syll, anchored ${stats.anchored}/${aligned.length}, interp ${stats.interpolated}, segs used ${stats.segsUsed}/${stats.segsUsed! + stats.segsSkipped!}, cost ${stats.cost?.toFixed(1)}`);
	console.log(`[align] cache times: ${aligned.map((l) => l.time.toFixed(1)).join(", ")}s`);
}

function maybeRunAlignment(position: number): void {
	if (!alignLines || alignSyncedSeen) return;
	if (!win || win.isDestroyed()) return;
	const now = Date.now();
	// the locker sees every tick — seek detection needs the 500ms
	// granularity, not the 5s alignment cadence
	alignLocker.onClock(position, now);
	if (position > alignMaxPos) alignMaxPos = position;
	if (now - alignLastRun < ALIGN_INTERVAL) return;
	alignLastRun = now;
	// paused (position frozen): no new vocal evidence can arrive — skip
	// the DP re-run (it produced identical output every 5s)
	if (Math.abs(position - alignLastPos) < 0.05) return;
	alignLastPos = position;
	const segs = getTrackSegments();
	if (segs.length < ALIGN_MIN_SEGMENTS) return;
	const stats: Partial<AlignStats> = {};
	const aligned = alignLyrics(alignLines, segs, trackLength, getTrackEnergy(), stats, position, alignLocker.current);
	if (!aligned.length) return;
	alignLocker.update(position, aligned, stats);
	const locked = alignLocker.current ? alignLocker.current.lineIdx + 1 : 0;
	console.log(`[align] live @ ${position.toFixed(1)}s: ${aligned.length} lines over ${segs.length} segs (refined ${stats.refined?.length ?? "?"}) — rate ${stats.rate} ms/syll, anchored ${stats.anchored}, interp ${stats.interpolated}, locked ${locked}, segs used ${stats.segsUsed} skipped ${stats.segsSkipped}, cost ${stats.cost?.toFixed(1)}`);
	console.log(`[align] times: ${aligned.map((l) => l.time.toFixed(1)).join(", ")}s`);
	upsertSource({ id: "aura", name: "aura", status: "ready", synchronized: true, lines: aligned });
	displayLyricsEvent("aura", "aura", { lines: aligned, synchronized: true });
}

function isPlaying(status: string | null | undefined): boolean {
	if (!status) return false;
	const s = status.toLowerCase();
	return s.includes("play") && !s.includes("pause");
}

function sniffMime(buf: Buffer): string {
	if (buf.length > 3 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
		return "image/png";
	if (buf.length > 1 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
	return "image/png";
}

// SMTC artwork can be low-res (Yandex Music sends a small PNG) — show it
// instantly, then quietly swap in a 512px version from iTunes/Deezer if the
// system art is under the threshold
const HIRES_MIN_WIDTH = 480;

function launchHiResUpgrade(id: string, title?: string, artist?: string): void {
	if (hiResLaunchedFor === id || !title) return;
	hiResLaunchedFor = id;
	const token = coverJobToken;
	void getFallbackCover(title, artist || "").then(async (art) => {
		if (!win || win.isDestroyed() || lastTrackId !== id || token !== coverJobToken) return;
		if (!art) return; // nothing better found — keep the SMTC artwork
		const url = `data:${sniffMime(art)};base64,${art.toString("base64")}`;
		const pal = (await extractPalette(art)) as Record<string, string | undefined> | null;
		if (!win || win.isDestroyed() || lastTrackId !== id || token !== coverJobToken) return;
		win.webContents.send("art", { artUrl: url, palette: pal });
	});
}

// no local .lrc for this track — ask Lrclib, then Genius, in the
// background; the result arrives as a separate "lyrics" event so the
// track payload isn't delayed. The event is sent even on a miss so the
// renderer can swap its loading indicator for the "not found" note.
function launchLyricsLookup(id: string, title?: string, artist?: string, duration?: number, strict = false): void {
	if (lyricsLaunchedFor === id) return;
	lyricsLaunchedFor = id;
	lyricsLookupDuration = duration || 0;
	lyricsFromLrclib = false;
	const token = lyricsJobToken;
	if (!title) {
		// nothing to search online — report the miss immediately
		if (win && !win.isDestroyed() && lastTrackId === id && token === lyricsJobToken) {
			sourcesSettled = true;
			broadcastSources();
			displayLyricsEvent(null, null, null);
		}
		return;
	}
	void lookupLyrics(title, artist || undefined, duration || undefined, config.geniusToken, strict).then((outcome) => {
		if (!win || win.isDestroyed() || lastTrackId !== id || token !== lyricsJobToken) return;
		const result = outcome.result;
		lyricsFromLrclib = !!result && result.source === "Lrclib";
		if (result && !result.synchronized && !result.instrumental && result.lines.length) {
			// plain text is all we have — align it live against vocal segments
			enterAlignment(result.lines, result.source, true);
		} else {
			alignSyncedSeen = !!result && result.synchronized;
			stopAlignment();
		}
		// register every source the pipeline found as a switchable candidate
		// (after enterAlignment/stopAlignment, so a cached "aura" verdict
		// isn't dropped as a pending live alignment)
		for (const cand of outcome.candidates) {
			upsertSource({
				id: cand.source,
				name: cand.source,
				status: "ready",
				synchronized: cand.synchronized,
				instrumental: cand.instrumental,
				lines: cand.lines
			});
		}
		sourcesSettled = true;
		broadcastSources();
		// cache hit (e.g. a saved aura alignment): the display shows the
		// cached verdict instantly; a read-only background re-search
		// recovers the other sources for the switcher — arrows appear as
		// they land, the screen stays on the cached version
		if (outcome.fromCache && result) {
			// the cached verdict already holds the Genius text ("Genius", or
			// an "aura" alignment built on it) — re-querying Genius recovers
			// nothing for the switcher and doubles the request volume that
			// gets us rate-limited; only Lrclib needs recovering
			const skipGenius = result.source === "Genius" || result.source === "aura";
			void lookupLyrics(title, artist || undefined, duration || undefined, config.geniusToken, strict, true, skipGenius).then((fresh) => {
				if (!win || win.isDestroyed() || lastTrackId !== id || token !== lyricsJobToken) return;
				for (const cand of fresh.candidates) {
					upsertSource({
						id: cand.source,
						name: cand.source,
						status: "ready",
						synchronized: cand.synchronized,
						instrumental: cand.instrumental,
						lines: cand.lines
					});
				}
			});
		}
		console.log(`[lyrics] "${title}" — ${artist || "?"} (dur=${Math.round(duration || 0)}s): ${result ? (result.instrumental ? `${result.source} (instrumental)` : `${result.source} (${result.synchronized ? "synced" : "plain"}, ${result.lines.length} lines)`) : "not found anywhere"}${outcome.lrclibPending ? " [lrclib pending — pursuing in background]" : ""}${outcome.lrclibVerify ? " [lrclib re-check scheduled]" : ""}${outcome.geniusPending ? " [genius pending — retrying in background]" : ""}`);
		displayLyricsEvent(result ? result.source : null, result ? result.source : null, result ? { lines: result.lines, synchronized: result.synchronized, instrumental: result.instrumental || undefined } : null);
		if (outcome.geniusPending && config.geniusToken) {
			// Genius answered transiently (403 rate limit / timeout) — keep
			// retrying it in the background; when it finally answers, the
			// missing text lands on screen (or joins the switcher next to
			// the Lrclib plain text, which stays the priority winner)
			void pursueGenius(title, artist || undefined, strict, config.geniusToken, result, (upgrade) => {
				if (!upgrade) return; // fallback stands (cached where definitive)
				if (!win || win.isDestroyed() || lastTrackId !== id || token !== lyricsJobToken) return;
				console.log(`[lyrics] "${title}" — ${artist || "?"}: Genius late upgrade (${upgrade.lines.length} lines)`);
				// a late Lrclib upgrade (pursue/verify) may have landed first —
				// synced Lrclib outranks plain Genius, never steal its screen
				if (!result && !lyricsFromLrclib) {
					// nothing was on screen — the late Genius text takes it
					// and aligns live, exactly like a fresh plain-text hit
					enterAlignment(upgrade.lines, "Genius", true);
				}
				upsertSource({
					id: "Genius",
					name: "Genius",
					status: "ready",
					synchronized: upgrade.synchronized,
					instrumental: upgrade.instrumental,
					lines: upgrade.lines
				});
				if (!result && !lyricsFromLrclib) {
					displayLyricsEvent("Genius", "Genius", { lines: upgrade.lines, synchronized: upgrade.synchronized, instrumental: upgrade.instrumental || undefined });
				}
			});
		}
		if (outcome.lrclibPending) {
			// Lrclib answered transiently — keep retrying it in the background;
			// when it finally answers, upgrade the display to the synced version
			void pursueLrclib(title, artist || undefined, duration || undefined, strict, result, (upgrade) => {
				if (!upgrade) return; // fallback stands (cached where definitive)
				if (!win || win.isDestroyed() || lastTrackId !== id || token !== lyricsJobToken) return;
				lyricsFromLrclib = true;
				alignSyncedSeen = true;
				stopAlignment();
				console.log(`[lyrics] "${title}" — ${artist || "?"}: Lrclib late upgrade (${upgrade.instrumental ? "instrumental" : `${upgrade.synchronized ? "synced" : "plain"}, ${upgrade.lines.length} lines`})`);
				upsertSource({
					id: upgrade.source,
					name: upgrade.source,
					status: "ready",
					synchronized: upgrade.synchronized,
					instrumental: upgrade.instrumental,
					lines: upgrade.lines
				});
				displayLyricsEvent(upgrade.source, upgrade.source, { lines: upgrade.lines, synchronized: upgrade.synchronized, instrumental: upgrade.instrumental || undefined });
			});
			return;
		}
		if (outcome.lrclibVerify) {
			// Lrclib said a definitive "no" but that flakes sometimes —
			// one delayed re-check; a hit swaps Genius for the synced version
			void verifyLrclib(title, artist || undefined, duration || undefined, strict, (upgrade) => {
				if (!upgrade) return; // the "no" was real — Genius verdict stands
				if (!win || win.isDestroyed() || lastTrackId !== id || token !== lyricsJobToken) return;
				lyricsFromLrclib = true;
				alignSyncedSeen = true;
				stopAlignment();
				console.log(`[lyrics] "${title}" — ${artist || "?"}: Lrclib re-check upgrade (${upgrade.instrumental ? "instrumental" : `${upgrade.synchronized ? "synced" : "plain"}, ${upgrade.lines.length} lines`})`);
				upsertSource({
					id: upgrade.source,
					name: upgrade.source,
					status: "ready",
					synchronized: upgrade.synchronized,
					instrumental: upgrade.instrumental,
					lines: upgrade.lines
				});
				displayLyricsEvent(upgrade.source, upgrade.source, { lines: upgrade.lines, synchronized: upgrade.synchronized, instrumental: upgrade.instrumental || undefined });
			});
		}
	});
}

// every app that ever held the current SMTC session lands in the settings'
// "Игнорировать" list — including ignored ones (to be un-ignored later).
// New apps are persisted at once; lastSeen is kept in memory and flushed
// on quit (a 500ms poll must not hammer the disk)
function recordSeenApp(update: Update): void {
	if (!update.app) return;
	const now = Date.now();
	let entry = config.seenApps.find((a) => a.app === update.app);
	if (!entry) {
		config.seenApps.push({ app: update.app, appName: update.appName || update.app, lastSeen: now });
		saveConfig(config);
	} else {
		entry.appName = update.appName || entry.appName;
		entry.lastSeen = now;
	}
}

function isIgnoredApp(app: string): boolean {
	return (config.ignoredApps || []).some((a) => a.toLowerCase() === app.toLowerCase());
}

async function handleUpdate(update: Update | null): Promise<boolean> {
	if (!win || win.isDestroyed()) return true;

	if (!update) {
		// media sessions can momentarily disappear (e.g. Yandex Music) —
		// only declare "nothing playing" after a few consecutive empties
		nullStreak++;
		if (lastTrackId !== null && nullStreak >= 3) {
			finalizeAlignment();
			beginTrack();
			alignSyncedSeen = false;
			resetSources();
			lastTrackId = null;
			lastStatus = null;
			lastTrackTitle = undefined;
			lastTrackArtist = undefined;
			artDeliveredFor = null;
			hiResLaunchedFor = null;
			lyricsLaunchedFor = null;
			lyricsJobToken++;
			win.webContents.send("track", { empty: true } as TrackPayload);
		}
		return true;
	}
	nullStreak = 0;
	recordSeenApp(update);
	// an ignored app (e.g. a messenger's voice messages) must not steal the
	// screen, restart lookups, or feed its positions into the track clock —
	// freeze on the last real track until a followed app is current again
	if (isIgnoredApp(update.app)) return false;

	const id = update.metadata.id;
	const smtcArt: Buffer | null = update.metadata.artData?.data?.length
		? update.metadata.artData.data
		: null;

	if (id !== lastTrackId) {
		finalizeAlignment();
		beginTrack();
		alignSyncedSeen = false;
		lastTrackId = id;
		lastStatus = null;
		lastTrackTitle = update.metadata.title;
		lastTrackArtist = update.metadata.artist;
		artDeliveredFor = null;
		fallbackLaunchedFor = null;
		hiResLaunchedFor = null;
		lyricsLaunchedFor = null;
		lyricsJobToken++;
		coverJobToken++;
		resetSources();
		// SMTC artwork often arrives after the metadata — give it time
		// before resorting to an online cover search
		coverDeadline = Date.now() + 2000;

		trackLength = update.metadata.length || 0;
		lyricsDurationFixed = false;

		let artUrl: string | null = null;
		let palette: Record<string, string | undefined> | null = null;
		if (smtcArt) {
			artUrl = `data:${sniffMime(smtcArt)};base64,${smtcArt.toString("base64")}`;
			palette = (await extractPalette(smtcArt)) as Record<string, string | undefined> | null;
			artDeliveredFor = id;
			if ((await artWidth(smtcArt)) < HIRES_MIN_WIDTH) {
				launchHiResUpgrade(id, update.metadata.title, update.metadata.artist);
			}
		}

		let lyrics: TrackPayload["lyrics"] = null;
		let lrcSource: string | null = null;
		if (index.tracks.length) {
			const track = findTrack(index, update.metadata.title, update.metadata.artist);
			if (track?.lrcPath) {
				try {
					const parsed = parseLrc(decodeLrcBuffer(fs.readFileSync(track.lrcPath)));
					lyrics = { lines: parsed.lines, synchronized: parsed.synchronized };
					lrcSource = path.basename(track.lrcPath);
					// local .lrc matched — no online search will run for this
					// track, so the source list is settled right away
					sourcesSettled = true;
					autoSourceId = "local";
					upsertSource({ id: "local", name: lrcSource, status: "ready", synchronized: parsed.synchronized, lines: parsed.lines });
					if (parsed.synchronized) alignSyncedSeen = true;
					// unsynced local .lrc — align live too, but never cache
					// over the user's own file
					else if (parsed.lines.length) enterAlignment(parsed.lines, lrcSource, false);
				} catch (_e) {
					// unreadable .lrc — report as not found
				}
			}
		}

		const payload: TrackPayload = {
			empty: false,
			title: update.metadata.title,
			artist: update.metadata.artist,
			album: update.metadata.album,
			appName: update.appName,
			status: update.status,
			capabilities: update.capabilities,
			length: trackLength,
			artUrl,
			palette,
			lyrics,
			lrcSource,
			libraryEmpty: index.tracks.length === 0
		};
		win.webContents.send("track", payload);

		if (!lyrics) {
			// SMTC's first update after a track switch can carry the PREVIOUS
			// track's length — give the poll loop (~500ms ticks) time to
			// deliver the real one before asking Lrclib: its ±15s duration
			// filter would reject every record with the stale value
			const token = lyricsJobToken;
			const t = update.metadata.title;
			const a = update.metadata.artist;
			setTimeout(() => {
				if (!win || win.isDestroyed() || lastTrackId !== id || token !== lyricsJobToken) return;
				launchLyricsLookup(id, t, a, trackLength);
			}, 2000);
		}
	} else if (update.status !== lastStatus) {
		win.webContents.send("status", { status: update.status, capabilities: update.capabilities });
	}

	// keep the length fresh on every update — the first one after a switch
	// may be stale; when a real correction arrives AFTER the online lookup
	// already went out with the wrong duration, its Lrclib verdict is
	// suspect (the ±15s filter rejected everything) — re-run it once
	if (update.metadata.length && update.metadata.length !== trackLength) {
		trackLength = update.metadata.length;
		// the renderer's seekbar learned the length only from the initial
		// track payload — a stale one must be corrected on screen too
		if (win && !win.isDestroyed()) {
			win.webContents.send("track-length", { length: trackLength });
		}
		if (
			lyricsLaunchedFor === id && !lyricsDurationFixed && lastTrackTitle &&
			Math.abs(trackLength - lyricsLookupDuration) > 5 && !lyricsFromLrclib
		) {
			lyricsDurationFixed = true;
			console.log(`[lyrics] "${lastTrackTitle}" — ${lastTrackArtist || "?"}: duration corrected ${Math.round(lyricsLookupDuration)}s → ${trackLength}s, re-running lookup`);
			clearLyricsCache(lastTrackArtist, lastTrackTitle);
			lyricsJobToken++;
			lyricsLaunchedFor = null;
			launchLyricsLookup(id, lastTrackTitle, lastTrackArtist, trackLength);
		}
	}

	// artwork still missing for the current track — SMTC art may appear late
	if (id === lastTrackId && artDeliveredFor !== id) {
		if (smtcArt) {
			// the system finally delivered its artwork — use it, cancel fallback
			artDeliveredFor = id;
			coverJobToken++;
			const url = `data:${sniffMime(smtcArt)};base64,${smtcArt.toString("base64")}`;
			const pal = (await extractPalette(smtcArt)) as Record<
				string,
				string | undefined
			> | null;
			if (win && !win.isDestroyed() && lastTrackId === id) {
				win.webContents.send("art", { artUrl: url, palette: pal });
			}
			if ((await artWidth(smtcArt)) < HIRES_MIN_WIDTH) {
				launchHiResUpgrade(id, update.metadata.title, update.metadata.artist);
			}
		} else if (Date.now() >= coverDeadline && fallbackLaunchedFor !== id) {
			// no system artwork within the grace period — search online
			fallbackLaunchedFor = id;
			const token = coverJobToken;
			const title = update.metadata.title;
			const artist = update.metadata.artist || "";
			void getFallbackCover(title, artist).then(async (art) => {
				if (!win || win.isDestroyed() || lastTrackId !== id) return;
				if (token !== coverJobToken || artDeliveredFor === id) return; // superseded
				if (!art) {
					win.webContents.send("art", { artUrl: null, palette: null });
					return;
				}
				const url = `data:${sniffMime(art)};base64,${art.toString("base64")}`;
				const pal = (await extractPalette(art)) as Record<
					string,
					string | undefined
				> | null;
				if (!win || win.isDestroyed() || lastTrackId !== id || token !== coverJobToken)
					return;
				artDeliveredFor = id;
				win.webContents.send("art", { artUrl: url, palette: pal });
			});
		}
	}
	lastStatus = update.status;
	return true;
}

// handleUpdate mutates module-level state (lastTrackId, job tokens, source
// entries) and its awaits (extractPalette) open interleaving windows — the
// 500ms poll tick, the watcher's session callback and rebuildIndex must
// never run it in parallel. Every caller goes through this chain
let updateChain: Promise<void> = Promise.resolve();
function queueUpdate(update: Update | null): Promise<boolean> {
	const run = updateChain.then(() => handleUpdate(update));
	// the chain itself must never reject — a failed run may not poison the
	// queue for every future update
	updateChain = run.then(
		() => undefined,
		() => undefined
	);
	return run;
}

async function rebuildIndex(): Promise<void> {
	index = await buildIndex(config.musicFolders);
	// force re-matching of the currently playing track against the fresh index
	lastTrackId = null;
	if (watcher) await queueUpdate(await watcher.getUpdate());
}

function libraryStats() {
	return {
		folders: config.musicFolders,
		trackCount: index.tracks.length,
		lrcCount: index.tracks.filter((t) => t.lrcPath).length
	};
}

function createWindow(): void {
	win = new BrowserWindow({
		width: 1180,
		height: 720,
		minWidth: 880,
		minHeight: 560,
		backgroundColor: "#161513",
		autoHideMenuBar: true,
		// no native overlay: the window controls are drawn by the renderer
		// (fully transparent, blending into the fluid background)
		titleBarStyle: "hidden",
		webPreferences: {
			contextIsolation: true,
			preload: path.join(__dirname, "preload.js")
		}
	});
	win.loadFile(path.join(app.getAppPath(), "src", "renderer", "index.html"));
	// external links (the Genius API page in settings) must open in the
	// system browser — without this target="_blank" would navigate the app
	// window itself to the site
	win.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url);
		return { action: "deny" };
	});
	win.on("closed", () => {
		win = null;
	});
	win.webContents.on("render-process-gone", (_e, details) => {
		console.error("Renderer gone:", details.reason);
		if (win && !win.isDestroyed() && details.reason !== "clean-exit") win.webContents.reload();
	});
	win.on("enter-full-screen", () => {
		if (win && !win.isDestroyed()) win.webContents.send("fullscreen", true);
	});
	win.on("leave-full-screen", () => {
		if (win && !win.isDestroyed()) win.webContents.send("fullscreen", false);
	});
	// custom window controls: the renderer's maximize button flips between
	// "maximize" and "restore" — keep it in sync with the real window state
	const sendMaximized = () => {
		if (win && !win.isDestroyed()) win.webContents.send("win-maximized", win.isMaximized());
	};
	win.on("maximize", sendMaximized);
	win.on("unmaximize", sendMaximized);
	win.webContents.once("did-finish-load", sendMaximized);
}

function registerIpc(): void {
	ipcMain.handle("get-config", () => libraryStats());

	ipcMain.handle("pick-folder", async () => {
		if (!win) return libraryStats();
		const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
		if (!result.canceled && result.filePaths[0]) {
			if (!config.musicFolders.includes(result.filePaths[0])) {
				config.musicFolders.push(result.filePaths[0]);
				saveConfig(config);
				await rebuildIndex();
			}
		}
		return libraryStats();
	});

	ipcMain.handle("remove-folder", async (_e, folder: string) => {
		config.musicFolders = config.musicFolders.filter((f) => f !== folder);
		saveConfig(config);
		await rebuildIndex();
		return libraryStats();
	});

	ipcMain.handle("reindex", async () => {
		await rebuildIndex();
		return libraryStats();
	});

	ipcMain.handle("cache:stats", () => lyricsCacheStats());

	// Genius access token: personal, lives only in the user's config.json —
	// never in sources or builds. Empty value removes it (Genius off)
	ipcMain.handle("token:get", () => ({ token: config.geniusToken || "" }));
	ipcMain.handle("token:set", (_e, token: unknown) => {
		const t = typeof token === "string" ? token.trim() : "";
		if (t) config.geniusToken = t;
		else delete config.geniusToken;
		saveConfig(config);
		return { token: config.geniusToken || "" };
	});

	// settings' "Игнорировать" section: every app seen holding the current
	// SMTC session, newest first, with its ignore state
	function appsListPayload() {
		return {
			apps: [...(config.seenApps || [])]
				.sort((a, b) => b.lastSeen - a.lastSeen)
				.map((a) => ({ app: a.app, appName: a.appName, ignored: isIgnoredApp(a.app) }))
		};
	}

	ipcMain.handle("apps:list", () => appsListPayload());

	ipcMain.handle("apps:toggle-ignore", (_e, app: string) => {
		if (typeof app !== "string" || !app) return appsListPayload();
		const list = config.ignoredApps || (config.ignoredApps = []);
		const i = list.findIndex((a) => a.toLowerCase() === app.toLowerCase());
		if (i >= 0) list.splice(i, 1);
		else list.push(app);
		saveConfig(config);
		return appsListPayload();
	});

	// settings: wipe the whole lyrics cache. The current track's verdict is
	// gone too — when its text came from the online chain, restart the whole
	// lookup from scratch (a local .lrc track is untouched by the cache, its
	// text stays)
	ipcMain.handle("cache:clear", () => {
		clearAllLyricsCache();
		if (lastTrackId && lastTrackTitle && lyricsLaunchedFor === lastTrackId) {
			manualSource = null;
			sourcesSettled = false;
			broadcastSources();
			lyricsJobToken++;
			lyricsLaunchedFor = null;
			launchLyricsLookup(lastTrackId, lastTrackTitle, lastTrackArtist, trackLength, false);
		}
		return lyricsCacheStats();
	});

	ipcMain.on("control", (_e, action: string) => {
		if (!watcher) return;
		if (action === "playpause") watcher.playPause();
		else if (action === "next") watcher.next();
		else if (action === "previous") watcher.previous();
	});

	ipcMain.on("control:seek", (_e, seconds: number) => {
		watcher?.seek(seconds);
	});

	ipcMain.on("control:fullscreen", () => {
		if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen());
	});

	// custom window controls (renderer-drawn, transparent): minimize /
	// maximize-toggle / close — the native overlay was removed because its
	// solid color strip stood out against the animated fluid background
	ipcMain.on("win-control", (_e, action: string) => {
		if (!win || win.isDestroyed()) return;
		if (action === "minimize") win.minimize();
		else if (action === "maximize") {
			if (win.isMaximized()) win.unmaximize();
			else win.maximize();
		} else if (action === "close") win.close();
	});

	// "wrong lyrics" — drop every cached verdict for the current track and
	// re-search in strict mode (exact title + required artist); a strict
	// miss is negative-cached, so the track won't be re-searched again
	ipcMain.on("lyrics:wrong", () => {
		if (!lastTrackId || !lastTrackTitle) return;
		clearLyricsCache(lastTrackArtist || undefined, lastTrackTitle);
		// re-search = back to the automatic source choice
		manualSource = null;
		sourcesSettled = false;
		broadcastSources();
		lyricsJobToken++;
		lyricsLaunchedFor = null;
		launchLyricsLookup(lastTrackId, lastTrackTitle, lastTrackArtist, trackLength, true);
	});

	// manual retry — drop every cached verdict and search again normally
	// (useful after a network failure or a stale negative cache)
	ipcMain.on("lyrics:retry", () => {
		if (!lastTrackId || !lastTrackTitle) return;
		clearLyricsCache(lastTrackArtist || undefined, lastTrackTitle);
		manualSource = null;
		sourcesSettled = false;
		broadcastSources();
		lyricsJobToken++;
		lyricsLaunchedFor = null;
		launchLyricsLookup(lastTrackId, lastTrackTitle, lastTrackArtist, trackLength, false);
	});

	// source switcher — force the displayed lyrics source; the choice owns
	// the screen until the track changes (or a re-search resets it)
	ipcMain.on("lyrics:select-source", (_e, id: unknown) => {
		const entry = typeof id === "string" ? sourceEntries.find((s) => s.id === id) : undefined;
		if (!entry || entry.status !== "ready" || !entry.lines) return;
		manualSource = id as string;
		if (!win || win.isDestroyed()) return;
		win.webContents.send("lyrics", {
			lyrics: { lines: entry.lines, synchronized: entry.synchronized, instrumental: entry.instrumental || undefined },
			source: entry.name
		});
		broadcastSources();
	});
}

// hardware acceleration is ON again (2026-10-08): with it disabled, the
// WebGL fluid background + full-window CSS blur rendered on the CPU and
// the UI dropped to ~2fps in fullscreen. The original disable was a
// workaround for AV/VPN injector crashes on one machine — if those
// return, crash dumps land in userData/crashes; no-sandbox stays for now
// (it was the bigger crash factor)
app.commandLine.appendSwitch("no-sandbox");

// the process sporadically dies with a native segfault (winplayer-node /
// sharp) — keep crash dumps locally so the next one is diagnosable
app.setPath("crashDumps", path.join(app.getPath("userData"), "crashes"));
crashReporter.start({ submitURL: "", uploadToServer: false });

app.whenReady().then(async () => {
	config = loadConfig();
	registerIpc();
	createWindow();
	initUpdater(() => win);

	// loopback capture + vocal DSP — dev only, never in the packaged app
	if (!app.isPackaged) startLoopback();

	watcher = new MediaWatcher(async () => {
		await queueUpdate(await watcher!.getUpdate());
	});

	// single serialized poll loop: track/status changes + position ticks.
	// all native calls go through the watcher's promise chain, never in parallel
	setInterval(async () => {
		if (!watcher || !win || win.isDestroyed()) return;
		try {
			const update = await watcher.getUpdate();
			const processed = await queueUpdate(update);
			// a frozen (ignored) session must not feed its positions into
			// the track clock, the aligner, or the seekbar either
			if (processed && update && lastTrackId !== null) {
				// GetPosition extrapolates by time since the player's last
				// timeline update — raw update.elapsed is stale between those
				// and makes the lyrics jitter back and forth
				const position = await watcher.getPosition();
				// Stage 2: pair the capture clock with the track clock and
				// re-align plain lyrics as vocal evidence accumulates
				noteTrackPosition(position);
				// revive the WASAPI capture if it silently died (device
				// change / exclusive-mode takeover) while music plays
				checkLoopbackWatchdog(isPlaying(update.status));
				maybeRunAlignment(position);
				if (win && !win.isDestroyed()) {
					win.webContents.send("position", {
						position,
						playing: isPlaying(update.status)
					});
				}
			}
		} catch (_e) {
			// frame may be gone — skip this tick
		}
	}, 500);

	// index the library in the background, then re-match the current track
	await rebuildIndex();
});

app.on("window-all-closed", () => {
	app.quit();
});

app.on("will-quit", () => {
	finalizeAlignment();
	stopLoopback();
	// flush the seen-apps registry's lastSeen updates (new apps are saved
	// the moment they appear; this covers the in-memory refreshes)
	saveConfig(config);
});
