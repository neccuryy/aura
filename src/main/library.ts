import * as fs from "fs";
import * as path from "path";
import * as musicMetadata from "music-metadata";

export interface TrackEntry {
	file: string;
	stem: string;
	title?: string;
	artist?: string;
	lrcPath?: string;
}

export interface LibraryIndex {
	tracks: TrackEntry[];
	indexedAt: number;
}

const AUDIO_EXTS = [".mp3", ".flac", ".m4a", ".ogg", ".oga", ".wav", ".opus", ".wma"];

function walk(dir: string, out: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (_e) {
		return;
	}
	for (const e of entries) {
		if (e.name.startsWith(".")) continue;
		const full = path.join(dir, e.name);
		if (e.isDirectory()) walk(full, out);
		else if (AUDIO_EXTS.includes(path.extname(e.name).toLowerCase())) out.push(full);
	}
}

export function normalizeName(s: string): string {
	return s
		.toLowerCase()
		.replace(/^\s*\d+\s*[.\-_)]\s*/, "") // strip leading track numbers: "1. ", "01 - "
		.replace(/\(.*?\)|\[.*?\]/g, " ") // strip parenthesized junk
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

export async function buildIndex(folders: string[]): Promise<LibraryIndex> {
	const files: string[] = [];
	for (const f of folders) walk(f, files);

	const tracks: TrackEntry[] = [];
	for (const file of files) {
		const stem = path.basename(file, path.extname(file));
		const lrcPath = path.join(path.dirname(file), stem + ".lrc");
		const entry: TrackEntry = { file, stem, lrcPath: fs.existsSync(lrcPath) ? lrcPath : undefined };
		try {
			const meta = await musicMetadata.parseFile(file, { duration: false });
			entry.title = meta.common.title;
			entry.artist = meta.common.artist || meta.common.albumartist;
		} catch (_e) {
			// tags unreadable — filename matching still works
		}
		tracks.push(entry);
	}
	return { tracks, indexedAt: Date.now() };
}

export function findTrack(
	index: LibraryIndex,
	title: string | undefined,
	artist: string | undefined
): TrackEntry | null {
	const nTitle = title ? normalizeName(title) : "";
	const nArtist = artist ? normalizeName(artist) : "";
	if (!nTitle) return null;

	let best: { track: TrackEntry; score: number } | null = null;
	for (const t of index.tracks) {
		let score = 0;
		const nStem = normalizeName(t.stem);
		if (t.title && normalizeName(t.title) === nTitle) score += 4;
		if (t.artist && nArtist && normalizeName(t.artist) === nArtist) score += 2;
		if (nStem === nTitle) score += 3;
		if (nStem && (nStem.includes(nTitle) || nTitle.includes(nStem))) score += 1;
		if (t.lrcPath) score += 0.5; // prefer tracks that actually have lyrics
		if (!best || score > best.score) best = { track: t, score };
	}
	return best && best.score >= 3 ? best.track : null;
}
