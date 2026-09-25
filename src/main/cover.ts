import { app } from "electron";
import * as crypto from "crypto";
import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import sharp from "sharp";

// SMTC sessions don't always carry artwork (e.g. Yandex Music) — fall back to
// the public iTunes Search API, which covers most artists, and cache on disk

export async function artWidth(buf: Buffer): Promise<number> {
	try {
		const meta = await sharp(buf).metadata();
		return meta.width || 0;
	} catch (_e) {
		return 0;
	}
}

function cacheDir(): string {
	return path.join(app.getPath("userData"), "covers");
}

// bump when the matching logic changes — old cached covers may be wrong,
// so the whole cache is wiped once per version (also on other machines
// where an old exe left bad entries)
const CACHE_VERSION = "2";

function ensureCacheVersion(dir: string): void {
	const marker = path.join(dir, ".v" + CACHE_VERSION);
	if (fs.existsSync(marker)) return;
	for (const f of fs.readdirSync(dir)) {
		try {
			fs.unlinkSync(path.join(dir, f));
		} catch (_e) {
			// best effort
		}
	}
	fs.writeFileSync(marker, "");
}

function cacheKey(artist: string, title: string): string {
	return crypto
		.createHash("md5")
		.update((artist.trim() + "|" + title.trim()).toLowerCase())
		.digest("hex");
}

function fetchText(url: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = https.get(url, { headers: { "User-Agent": "aura/0.1.0" } }, (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				return reject(new Error("HTTP " + res.statusCode));
			}
			let data = "";
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => resolve(data));
		});
		req.on("error", reject);
		req.setTimeout(8000, () => req.destroy(new Error("timeout")));
	});
}

function fetchBuffer(url: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const req = https.get(url, { headers: { "User-Agent": "aura/0.1.0" } }, (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				return reject(new Error("HTTP " + res.statusCode));
			}
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve(Buffer.concat(chunks)));
		});
		req.on("error", reject);
		req.setTimeout(8000, () => req.destroy(new Error("timeout")));
	});
}

// search APIs return random popular songs for obscure queries — a wrong
// cover is worse than no cover, so only accept results that actually match
// the playing track
// ё and е are the same letter to any Russian speaker, but Genius often stores
// titles with е where the player reports ё ("пятёрочки"/"пятерочки")
export function norm(s: string | undefined | null): string {
	return (s || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-z0-9а-я]+/gi, " ").trim();
}

// players and online DBs append bracketed annotations the other side doesn't
// show — Yandex adds "[prod. by X]", Genius adds "(Say wha')" translations,
// "(feat. X)", "(Speed Up)" versions. Strip them from both sides before
// comparing, or the 0.65 length guard rejects legitimate hits.
// If a title is ENTIRELY bracketed, keep it as-is (nothing to match otherwise).
export function stripBrackets(s: string | undefined | null): string {
	const stripped = (s || "").replace(/[(\[{][^)\]}]*[)\]}]/g, " ");
	return stripped.trim() ? stripped : (s || "");
}

export function normTitle(s: string | undefined | null): string {
	return norm(stripBrackets(s));
}

const TRANSLIT_MAP: Record<string, string> = {
	"а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
	"ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
	"н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
	"ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
	"ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya"
};

// Genius search indexes Cyrillic poorly — its DB often only matches the
// Latin transliteration stored in parentheses ("Лилая (Lilaya)" is only
// findable as "lilaya")
export function translit(s: string | undefined | null): string {
	return (s || "").replace(/[а-яё]/gi, (ch) => {
		const lower = ch.toLowerCase();
		const t = TRANSLIT_MAP[lower] ?? ch;
		return ch === lower ? t : t.charAt(0).toUpperCase() + t.slice(1);
	});
}

export function looseMatch(a: string | undefined | null, b: string | undefined | null): boolean {
	const na = norm(a), nb = norm(b);
	if (!na || !nb) return false;
	return na.includes(nb) || nb.includes(na);
}

// players censor some words with * $ @ # — Genius stores the uncensored
// title, so a masked word never matches. Drop masked words from BOTH sides
// and compare what's left. Titles only — artists like "$uicideboy$" would
// be emptied by this.
const MASK_CHARS = /[*@$#]/;

export function dropMaskedWords(s: string | undefined | null): string {
	const words = (s || "").trim().split(/\s+/).filter((w) => w && !MASK_CHARS.test(w));
	return words.join(" ").trim();
}

function maskedTitleMatch(a: string | undefined | null, b: string | undefined | null): boolean {
	const na = norm(dropMaskedWords(stripBrackets(a)));
	const nb = norm(dropMaskedWords(stripBrackets(b)));
	if (!na || !nb) return false;
	if (na === nb) return true;
	const shorter = na.length < nb.length ? na : nb;
	const longer = na.length < nb.length ? nb : na;
	return longer.includes(shorter) && shorter.length >= longer.length * 0.65;
}

// inclusion only counts for comparable-length titles — "тот день" must
// not pass as a match for "тот день, когда я ушёл"
export function titleMatch(a: string | undefined | null, b: string | undefined | null): boolean {
	const na = normTitle(a), nb = normTitle(b);
	if (!na || !nb) return false;
	if (na === nb) return true;
	const shorter = na.length < nb.length ? na : nb;
	const longer = na.length < nb.length ? nb : na;
	if (longer.includes(shorter) && shorter.length >= longer.length * 0.65) return true;
	// censored title on one side — retry with masked words dropped
	if (MASK_CHARS.test(a || "") || MASK_CHARS.test(b || "")) {
		return maskedTitleMatch(a, b);
	}
	return false;
}

async function fromItunes(title: string, artist: string): Promise<string | null> {
	const term = encodeURIComponent((artist ? artist + " " : "") + title);
	const json = JSON.parse(
		await fetchText(`https://itunes.apple.com/search?term=${term}&entity=song&limit=5`)
	);
	const results: any[] = json?.results || [];
	const wantArtist = !!norm(artist);
	const hit = results.find((r) => {
		const tOk = looseMatch(r.trackName, title);
		const aOk = wantArtist ? looseMatch(r.artistName, artist) : true;
		return tOk && aOk;
	});
	return hit?.artworkUrl100 ? hit.artworkUrl100.replace("100x100", "512x512") : null;
}

async function fromDeezer(title: string, artist: string): Promise<string | null> {
	const q = encodeURIComponent((artist ? artist + " " : "") + title);
	const json = JSON.parse(await fetchText(`https://api.deezer.com/search?q=${q}&limit=5`));
	const results: any[] = json?.data || [];
	const wantArtist = !!norm(artist);
	const hit = results.find((r) => {
		const tOk = looseMatch(r.title, title);
		const aOk = wantArtist ? looseMatch(r.artist?.name, artist) : true;
		return tOk && aOk;
	});
	return hit?.album?.cover_big || null;
}

export async function getFallbackCover(title: string, artist: string): Promise<Buffer | null> {
	if (!title) return null;

	const dir = cacheDir();
	fs.mkdirSync(dir, { recursive: true });
	ensureCacheVersion(dir);
	const key = cacheKey(artist || "", title);

	// negative cache: don't re-query the APIs for tracks they couldn't find
	const missMarker = path.join(dir, key + ".miss");
	if (fs.existsSync(missMarker)) return null;

	const cached = fs.readdirSync(dir).find((f) => f.startsWith(key + "."));
	if (cached) {
		try {
			return fs.readFileSync(path.join(dir, cached));
		} catch (_e) {
			// unreadable cache entry — fall through to a fresh fetch
		}
	}

	try {
		let url = await fromItunes(title, artist);
		if (!url) url = await fromDeezer(title, artist);
		if (!url) {
			fs.writeFileSync(missMarker, "");
			return null;
		}
		const buf = await fetchBuffer(url);
		const ext = url.includes(".png") ? "png" : "jpg";
		fs.writeFileSync(path.join(dir, `${key}.${ext}`), buf);
		return buf;
	} catch (_e) {
		return null; // network hiccup — don't negative-cache, retry next time
	}
}
