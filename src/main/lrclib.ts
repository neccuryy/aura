import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { app } from "electron";
import { parseLrc, LrcFile } from "./lrc";
import { normTitle, looseMatch, titleMatch, stripBrackets } from "./cover";
import { getGeniusLyrics } from "./genius";

// Lrclib (https://lrclib.net) — free, no-token API for synced lyrics.
// Fallback when no local .lrc sits next to the track.

interface LrcLibRecord {
	trackName: string;
	artistName: string;
	duration: number;
	instrumental: boolean;
	plainLyrics: string | null;
	syncedLyrics: string | null;
}

export interface OnlineLyrics {
	lines: LrcFile["lines"];
	synchronized: boolean;
	source: string;
	// Lrclib flags the track as instrumental — no lyrics exist by design;
	// the renderer shows a dedicated placeholder instead of "not found"
	instrumental?: boolean;
}

const REQUEST_TIMEOUT = 8000;
const USER_AGENT = "aura/0.1.0 (https://github.com/aura-app)";

function fetchJson(url: string): Promise<{ status: number; data: unknown } | null> {
	return new Promise((resolve) => {
		const req = https.get(url, {
			timeout: REQUEST_TIMEOUT,
			headers: { "User-Agent": USER_AGENT },
		}, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => body += chunk);
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

function toResult(rec: LrcLibRecord): OnlineLyrics | null {
	if (rec.instrumental) {
		return { lines: [], synchronized: false, source: "Lrclib", instrumental: true };
	}
	if (rec.syncedLyrics) {
		const parsed = parseLrc(rec.syncedLyrics);
		if (parsed.synchronized && parsed.lines.length > 0) {
			return { lines: parsed.lines, synchronized: true, source: "Lrclib" };
		}
	}
	if (rec.plainLyrics) {
		const lines = rec.plainLyrics.split("\n").map((t) => ({ text: t.trim(), time: -1 }));
		if (lines.length > 0) return { lines, synchronized: false, source: "Lrclib" };
	}
	return null;
}

// ok: endpoint answered with usable data; miss: endpoint answered, there is
// definitely nothing; transient: 429/5xx — busy, retry later; null: network
// error. Neither transient nor null may ever negative-cache.
type ApiOutcome<T> =
	| { kind: "ok"; data: T }
	| { kind: "miss" }
	| { kind: "transient" }
	| null;

function outcome<T>(
	res: { status: number; data: unknown } | null,
	validate: (data: unknown) => T | null
): ApiOutcome<T> {
	if (!res) return null;
	if (res.status === 200) {
		const data = validate(res.data);
		return data ? { kind: "ok", data } : { kind: "miss" };
	}
	// server busy / rate limited — say nothing about existence
	if (res.status === 429 || res.status >= 500) return { kind: "transient" };
	return { kind: "miss" };
}

function apiGet(title: string, artist: string | undefined, duration: number | undefined): Promise<ApiOutcome<LrcLibRecord>> {
	const params = new URLSearchParams({ track_name: title });
	if (artist) params.set("artist_name", artist);
	if (duration) params.set("duration", String(Math.round(duration)));
	return fetchJson(`https://lrclib.net/api/get?${params}`).then((res) =>
		outcome(res, (d) =>
			d && typeof d === "object" && !Array.isArray(d) ? (d as LrcLibRecord) : null
		)
	);
}

function apiSearch(title: string, artist: string | undefined): Promise<ApiOutcome<LrcLibRecord[]>> {
	const params = new URLSearchParams({ track_name: title });
	if (artist) params.set("artist_name", artist);
	return fetchJson(`https://lrclib.net/api/search?${params}`).then((res) =>
		outcome(res, (d) => (Array.isArray(d) ? (d as LrcLibRecord[]) : null))
	);
}

// hard filters — a candidate must clear ALL of them before scoring.
// A wrong lyric is worse than no lyric.
function recordMatches(
	rec: LrcLibRecord,
	title: string,
	artist: string | undefined,
	duration: number | undefined,
	strict: boolean
): boolean {
	// strict mode (manual "wrong lyrics" retry): exact title only
	if (strict) {
		if (normTitle(rec.trackName) !== normTitle(title)) return false;
	} else if (!titleMatch(rec.trackName, title)) {
		return false;
	}
	// the player's artist must appear in the record's artist field
	// (feat. lists are covered by the inclusion check; brackets like
	// "MAYOT (Ft. X)" are stripped so the primary artist still matches)
	if (artist && !looseMatch(stripBrackets(rec.artistName), artist)) return false;
	// duration is a strong signal — a 15s+ drift means a different song
	if (duration && rec.duration && Math.abs(rec.duration - duration) > 15) return false;
	return true;
}

// ranking among already-matching records
function scoreRecord(rec: LrcLibRecord, title: string, artist: string | undefined, duration: number | undefined): number {
	let score = 0;
	if (normTitle(rec.trackName) === normTitle(title)) score += 4;
	if (artist && looseMatch(rec.artistName, artist)) score += 2;
	if (duration && rec.duration) {
		const diff = Math.abs(rec.duration - duration);
		if (diff <= 5) score += 3;
		else if (diff <= 12) score += 1;
	}
	if (rec.syncedLyrics && !rec.instrumental) score += 1;
	return score;
}

function cacheDir(): string {
	return path.join(app.getPath("userData"), "lyrics");
}

function cacheKey(artist: string | undefined, title: string): string {
	return createHash("md5").update(`${artist || ""}|${title}`).digest("hex");
}

function cacheBase(artist: string | undefined, title: string): string {
	return path.join(cacheDir(), cacheKey(artist, title));
}

function readCache(artist: string | undefined, title: string): OnlineLyrics | null | undefined {
	try {
		const file = `${cacheBase(artist, title)}.json`;
		if (!fs.existsSync(file)) return undefined;
		return JSON.parse(fs.readFileSync(file, "utf8")) as OnlineLyrics;
	} catch (_e) {
		return undefined;
	}
}

function writeCache(artist: string | undefined, title: string, result: OnlineLyrics | null, definitive: boolean): void {
	try {
		fs.mkdirSync(cacheDir(), { recursive: true });
		const base = cacheBase(artist, title);
		if (result) {
			fs.writeFileSync(`${base}.json`, JSON.stringify(result));
		} else if (definitive) {
			// only cache a miss when the whole pipeline definitively 404'd —
			// a network error must not poison the cache
			fs.writeFileSync(`${base}.miss`, "");
		}
	} catch (_e) {}
}

function hasMiss(artist: string | undefined, title: string): boolean {
	try {
		return fs.existsSync(`${cacheBase(artist, title)}.miss`);
	} catch (_e) {
		return false;
	}
}

// manual "wrong lyrics" reset: drop every cached verdict for this track
export function clearLyricsCache(artist: string | undefined, title: string): void {
	try {
		const base = cacheBase(artist, title);
		for (const file of [`${base}.json`, `${base}.miss`]) {
			if (fs.existsSync(file)) fs.unlinkSync(file);
		}
	} catch (_e) {}
}

// Stage 2 (aura-align): persist a locally computed alignment so the next
// play starts synced. Only called when no synced version was delivered for
// the track; still refuses to overwrite a cached synced verdict (a late
// Lrclib upgrade may have landed after the display was last touched)
export function saveAlignedLyrics(
	artist: string | undefined,
	title: string,
	lines: { text: string; time: number }[]
): void {
	const cached = readCache(artist, title);
	if (cached && cached.synchronized) return;
	writeCache(artist, title, { lines, synchronized: true, source: "aura-align" }, true);
}

async function fetchFromLrclib(
	title: string,
	artist: string | undefined,
	duration: number | undefined,
	strict: boolean
): Promise<{ result: OnlineLyrics | null; definitive: boolean }> {
	// queries go out with the cleaned title — bracketed junk like
	// "[prod. by X]" poisons the search on the server side
	const cleanTitle = stripBrackets(title);
	const direct = await apiGet(cleanTitle, artist, duration);
	if (direct && direct.kind === "ok" && recordMatches(direct.data, title, artist, duration, strict)) {
		const result = toResult(direct.data);
		if (result) return { result, definitive: true };
	}

	const search = await apiSearch(cleanTitle, artist);
	if (search && search.kind === "ok") {
		let best: LrcLibRecord | null = null;
		let bestScore = 0;
		for (const rec of search.data) {
			if (!recordMatches(rec, title, artist, duration, strict)) continue;
			const score = scoreRecord(rec, title, artist, duration);
			if (score > bestScore) {
				bestScore = score;
				best = rec;
			}
		}
		if (best) {
			const result = toResult(best);
			if (result) return { result, definitive: true };
		}
	}

	// definitive = every endpoint we asked actually answered (ok or miss);
	// transient (429/5xx) and network errors are NOT definitive
	const directAnswered = direct !== null && direct.kind !== "transient";
	const searchAnswered = search !== null && search.kind !== "transient";
	return { result: null, definitive: directAnswered && searchAnswered };
}

export interface LookupOutcome {
	result: OnlineLyrics | null;
	// true when Lrclib answered transiently (429/5xx/timeout) — the caller
	// should keep retrying it in the background and upgrade the displayed
	// Genius text to the synced Lrclib version when it finally answers
	lrclibPending: boolean;
	// true when Lrclib answered a definitive "no" but Genius found something —
	// Lrclib's "no" occasionally flakes (empty search with 200), so the caller
	// schedules one background re-check to catch it
	lrclibVerify: boolean;
}

// full pipeline: Lrclib first (synced lyrics when available), then Genius
// (plain lyrics) for tracks Lrclib doesn't have at all.
// strict = manual retry after a wrong match: exact title, no fuzzy anything.
export async function lookupLyrics(
	title: string,
	artist: string | undefined,
	duration: number | undefined,
	geniusToken?: string,
	strict = false
): Promise<LookupOutcome> {
	if (!title) return { result: null, lrclibPending: false, lrclibVerify: false };

	const cached = readCache(artist, title);
	if (cached !== undefined) return { result: cached, lrclibPending: false, lrclibVerify: false };
	if (hasMiss(artist, title)) return { result: null, lrclibPending: false, lrclibVerify: false };

	const lrclib = await fetchFromLrclib(title, artist, duration, strict);
	if (lrclib.result) {
		writeCache(artist, title, lrclib.result, true);
		return { result: lrclib.result, lrclibPending: false, lrclibVerify: false };
	}

	let geniusResult: OnlineLyrics | null = null;
	let geniusDefinitive = true; // no token → Genius doesn't affect the verdict
	if (geniusToken) {
		const genius = await getGeniusLyrics(title, artist, geniusToken, strict);
		if (genius.result) geniusResult = genius.result;
		else geniusDefinitive = genius.definitive;
	}

	if (!lrclib.definitive) {
		// Lrclib never actually answered — show whatever Genius found but
		// cache nothing; the caller runs pursueLrclib to keep trying for
		// the synced version
		return { result: geniusResult, lrclibPending: true, lrclibVerify: false };
	}

	// negative-cache only when the whole pipeline answered definitively —
	// a network error anywhere must not poison the cache
	writeCache(artist, title, geniusResult, geniusDefinitive);
	// Lrclib's definitive "no" sometimes flakes — when Genius covered the
	// track, re-check Lrclib once in the background
	return { result: geniusResult, lrclibPending: false, lrclibVerify: !!geniusResult };
}

// first retry almost immediately — a transient 429/timeout often clears at
// once, so the Genius→Lrclib upgrade lands within seconds — then back off
const PURSUE_DELAYS = [2000, 15000, 30000, 60000, 120000, 300000];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Background Lrclib priority: Lrclib answered transiently and the Genius
// text is already on screen — keep retrying Lrclib. When it finally answers
// definitively: a hit upgrades the display to the synced version (cached);
// a definitive miss confirms the fallback (Genius text or "not found",
// cached). ~10 minutes of attempts, then it gives up and leaves the cache
// empty so the next play retries the whole chain naturally.
export async function pursueLrclib(
	title: string,
	artist: string | undefined,
	duration: number | undefined,
	strict: boolean,
	fallback: OnlineLyrics | null,
	onResolved: (upgrade: OnlineLyrics | null) => void
): Promise<void> {
	for (const delay of PURSUE_DELAYS) {
		await sleep(delay);
		const lrclib = await fetchFromLrclib(title, artist, duration, strict);
		if (lrclib.result) {
			writeCache(artist, title, lrclib.result, true);
			onResolved(lrclib.result);
			return;
		}
		if (lrclib.definitive) {
			writeCache(artist, title, fallback, true);
			onResolved(null);
			return;
		}
	}
	onResolved(null);
}

const VERIFY_DELAY = 10000;

// Lrclib answered a definitive "no" but that answer sometimes flakes
// (e.g. search returning an empty array with 200). One delayed re-check:
// a hit overwrites the cached Genius verdict and upgrades the display;
// anything else leaves the cache as is.
export async function verifyLrclib(
	title: string,
	artist: string | undefined,
	duration: number | undefined,
	strict: boolean,
	onUpgrade: (upgrade: OnlineLyrics | null) => void
): Promise<void> {
	await sleep(VERIFY_DELAY);
	const lrclib = await fetchFromLrclib(title, artist, duration, strict);
	if (lrclib.result) {
		writeCache(artist, title, lrclib.result, true);
		onUpgrade(lrclib.result);
		return;
	}
	onUpgrade(null);
}
