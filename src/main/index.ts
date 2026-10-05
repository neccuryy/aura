import { app, BrowserWindow, dialog, ipcMain, crashReporter } from "electron";
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
import { lookupLyrics, pursueLrclib, verifyLrclib, clearLyricsCache, saveAlignedLyrics, lyricsCacheStats, clearAllLyricsCache } from "./lrclib";
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
let config: AuraConfig = { musicFolders: [] };
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
	// quality gate: a partial listen (track skipped early) produces a
	// garbage alignment that would poison the cache for every future play.
	// progress — how far into the track the vocal evidence reaches;
	// coverage — heard vocal time vs the expected sung duration
	const heard = segs.reduce((s, g) => s + (g.end - g.start), 0);
	const lastEnd = segs.reduce((m, g) => Math.max(m, g.end), 0);
	const progress = trackLength > 0 ? lastEnd / trackLength : 1;
	const coverage = stats.expected ? heard / stats.expected : 1;
	if (progress < 0.75 || coverage < 0.4) {
		console.log(`[align] "${lastTrackTitle}" — quality gate: progress ${(progress * 100).toFixed(0)}%, coverage ${(coverage * 100).toFixed(0)}% — partial listen, not cached`);
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
	if (now - alignLastRun < ALIGN_INTERVAL) return;
	alignLastRun = now;
	alignLocker.onClock(position, now);
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
			void lookupLyrics(title, artist || undefined, duration || undefined, config.geniusToken, strict, true).then((fresh) => {
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
		console.log(`[lyrics] "${title}" — ${artist || "?"} (dur=${Math.round(duration || 0)}s): ${result ? (result.instrumental ? `${result.source} (instrumental)` : `${result.source} (${result.synchronized ? "synced" : "plain"}, ${result.lines.length} lines)`) : "not found anywhere"}${outcome.lrclibPending ? " [lrclib pending — pursuing in background]" : ""}${outcome.lrclibVerify ? " [lrclib re-check scheduled]" : ""}`);
		displayLyricsEvent(result ? result.source : null, result ? result.source : null, result ? { lines: result.lines, synchronized: result.synchronized, instrumental: result.instrumental || undefined } : null);
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

async function handleUpdate(update: Update | null): Promise<void> {
	if (!win || win.isDestroyed()) return;

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
		return;
	}
	nullStreak = 0;

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
}

async function rebuildIndex(): Promise<void> {
	index = await buildIndex(config.musicFolders);
	// force re-matching of the currently playing track against the fresh index
	lastTrackId = null;
	if (watcher) await handleUpdate(await watcher.getUpdate());
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
		titleBarStyle: "hidden",
		titleBarOverlay: {
			color: "#161513",
			symbolColor: "#f5f5f4",
			height: 36
		},
		webPreferences: {
			contextIsolation: true,
			preload: path.join(__dirname, "preload.js")
		}
	});
	win.loadFile(path.join(app.getAppPath(), "src", "renderer", "index.html"));
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

	// the renderer recolors the native title-bar overlay to match the palette
	ipcMain.on("titlebar", (_e, colors: { color: string; symbolColor: string }) => {
		if (win && !win.isDestroyed()) {
			try {
				win.setTitleBarOverlay(colors);
			} catch (_e) {
				// overlay not available (e.g. unsupported platform) — ignore
			}
		}
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

// system security software (AV/VPN injectors) can crash Chromium sandboxed
// child processes on this machine — the app is local-only, so run without them
app.disableHardwareAcceleration();
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
		await handleUpdate(await watcher!.getUpdate());
	});

	// single serialized poll loop: track/status changes + position ticks.
	// all native calls go through the watcher's promise chain, never in parallel
	setInterval(async () => {
		if (!watcher || !win || win.isDestroyed()) return;
		try {
			const update = await watcher.getUpdate();
			await handleUpdate(update);
			if (update && lastTrackId !== null) {
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
});
