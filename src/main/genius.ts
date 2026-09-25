import * as https from "https";
import { normTitle, looseMatch, titleMatch, stripBrackets, translit } from "./cover";
import type { OnlineLyrics } from "./lrclib";

// Genius: the official API returns metadata only — the lyrics themselves
// are scraped from the song page. They live in the page's embedded
// __PRELOADED_STATE__ JSON (songPage.lyricsData.body.html), which is far
// more stable than the randomly-generated Lyrics__Container class names.

interface GeniusHit {
	type: string;
	result: {
		id: number;
		title: string;
		artist_names?: string;
		path: string;
		lyrics_state?: string;
		primary_artist?: { names?: string };
	};
}

export interface GeniusOutcome {
	result: OnlineLyrics | null;
	// true when Genius definitely has nothing for this query (API answered,
	// no matching song / no lyrics on the page) — false on network errors
	definitive: boolean;
}

const REQUEST_TIMEOUT = 8000;
const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function fetch(
	url: string,
	headers: Record<string, string>
): Promise<{ status: number; body: string } | null> {
	return new Promise((resolve) => {
		const req = https.get(url, { timeout: REQUEST_TIMEOUT, headers }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode || 0, body }));
		});
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(null));
	});
}

function decodeEntities(s: string): string {
	return s
		.replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function htmlToLines(html: string): { text: string; time: number }[] {
	const text = decodeEntities(
		html
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/p>/gi, "\n")
			.replace(/<[^>]+>/g, "")
	);
	return text
		.split("\n")
		.map((l) => l.trim())
		// drop structural markers like [Verse 1] / [Chorus] — they are not sung
		.filter((l) => l.length > 0 && !/^\[[^\]]+\]$/.test(l))
		.map((l) => ({ text: l, time: -1 }));
}

function extractLyricsHtml(pageHtml: string): string | null {
	const m = pageHtml.match(
		/window\.__PRELOADED_STATE__\s*=\s*JSON\.parse\('((?:[^'\\]|\\.)*)'\)/
	);
	if (!m) return null;
	try {
		// the captured text is a JS single-quoted string body: JSON escapes
		// plus \' — normalize \' away, then unescape via a JSON string parse
		const captured = m[1].replace(/\\'/g, "'");
		const inner = JSON.parse('"' + captured + '"');
		const state = JSON.parse(inner);
		const html = state?.songPage?.lyricsData?.body?.html;
		return typeof html === "string" ? html : null;
	} catch (_e) {
		return null;
	}
}

function pickHit(hits: GeniusHit[], title: string, artist: string | undefined, strict: boolean): GeniusHit | null {
	let best: GeniusHit | null = null;
	let bestScore = 0;
	for (const hit of hits) {
		if (hit.type !== "song" || !hit.result?.path) continue;
		// translation pages ("Песня (English Translation)") carry translated
		// lyrics, not the song's own text — never pick them over the original
		if (/\((english translation|traducci[oó]n|tradu[cç][aã]o|перевод)\)/i.test(hit.result.title)) continue;
		// strict mode (manual "wrong lyrics" retry): exact title only;
		// otherwise a comparable-length inclusion — Genius search also
		// returns loose neighbors
		if (strict) {
			if (normTitle(hit.result.title) !== normTitle(title)) continue;
		} else if (!titleMatch(hit.result.title, title)) {
			continue;
		}
		// the player's artist is required — a title-only match is how
		// wrong songs sneak in. Genius formats feats as "MAYOT (Ft. X & Y)";
		// strip the bracketed feat list so the primary artist can match
		// the player's full artist list
		const names = hit.result.artist_names || hit.result.primary_artist?.names;
		if (artist && !looseMatch(stripBrackets(names), artist)) continue;
		let score = 4;
		if (hit.result.lyrics_state === "complete") score += 1;
		if (score > bestScore) {
			bestScore = score;
			best = hit;
		}
	}
	return best;
}

export async function getGeniusLyrics(
	title: string,
	artist: string | undefined,
	token: string,
	strict = false
): Promise<GeniusOutcome> {
	// search with the cleaned title — bracketed junk like "[prod. by X]"
	// poisons the query on the server side
	const cleanTitle = stripBrackets(title);
	// the API search indexes Cyrillic poorly — when the plain query finds
	// nothing, retry with the Latin transliteration of the artist
	// ("Лилая (Lilaya)" is only findable as "lilaya")
	const queries: string[] = [];
	if (artist) {
		queries.push(`${cleanTitle} ${artist}`);
		const ta = translit(artist);
		if (ta && ta !== artist) {
			queries.push(`${cleanTitle} ${ta}`, ta);
		}
	} else {
		queries.push(cleanTitle);
	}

	for (const q of queries) {
		const search = await fetch(
			`https://api.genius.com/search?q=${encodeURIComponent(q)}`,
			{ Authorization: `Bearer ${token}`, "User-Agent": "aura/0.1.0" }
		);
		if (!search) return { result: null, definitive: false };
		if (search.status !== 200) return { result: null, definitive: true };

		let hits: GeniusHit[] = [];
		try {
			const parsed = JSON.parse(search.body);
			hits = parsed?.response?.hits || [];
		} catch (_e) {
			return { result: null, definitive: true };
		}

		const hit = pickHit(hits, title, artist, strict);
		if (!hit) continue; // try the next query variant

		const page = await fetch(`https://genius.com${hit.result.path}`, {
			"User-Agent": BROWSER_UA,
			Accept: "text/html"
		});
		if (!page) return { result: null, definitive: false };
		if (page.status !== 200) return { result: null, definitive: true };

		const lyricsHtml = extractLyricsHtml(page.body);
		if (!lyricsHtml) return { result: null, definitive: true };

		const lines = htmlToLines(lyricsHtml);
		if (lines.length === 0) return { result: null, definitive: true };

		return {
			result: { lines, synchronized: false, source: "Genius" },
			definitive: true
		};
	}

	return { result: null, definitive: true };
}
