import * as fs from "fs";
import * as iconv from "iconv-lite";

export interface LrcLine {
	text: string;
	time: number;
}

export interface LrcFile {
	metadata: Record<string, string>;
	lines: LrcLine[];
	synchronized: boolean;
}

const timestampRegex = /(?:\[(\d+:\d+\.?\d+)\])/g;
const lineRegex = /((?:\[\d+:\d+\.?\d+\])+)(.*)/;

function convertTime(timeString: string): number {
	const [minutes, seconds] = timeString.split(":");
	return parseInt(minutes) * 60 + parseFloat(seconds);
}

export function decodeLrcBuffer(buf: Buffer): string {
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return iconv.decode(buf, "utf-16le");
	if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
		return buf.toString("utf-8", 3);
	const utf8 = buf.toString("utf-8");
	if (!utf8.includes("\uFFFD")) return utf8;
	// common for Russian .lrc files saved in windows-1251
	return iconv.decode(buf, "windows-1251");
}

export function parseLrc(data: string): LrcFile {
	const result: LrcFile = { metadata: {}, lines: [], synchronized: true };

	// strip enhanced LRC word timestamps, normalize [mm:ss] to [mm:ss.000]
	data = data.replace(/<\d+:\d+\.\d+>/g, "").replace(/<\d+:\d+>/g, "").replace(/<\d+>/g, "");
	data = data.replace(/\[(\d+):(\d+)\]/g, (_m, p1: string, p2: string) => `[${p1}:${p2}.000]`);

	const lines = data.trim().split(/\r?\n/).map((x) => x.trim());

	for (const line of lines) {
		const m = lineRegex.exec(line);
		if (m) {
			for (const t of m[1].matchAll(timestampRegex))
				result.lines.push({ text: m[2].replace(/\s+/g, " ").trim(), time: convertTime(t[1]) });
		} else if (line.startsWith("[") && line.endsWith("]")) {
			const body = line.slice(1, -1);
			const idx = body.indexOf(":");
			if (idx > 0) result.metadata[body.slice(0, idx).trim()] = body.slice(idx + 1).trim();
		} else if (line.length) {
			// plain text line — unsynchronized lyrics
			result.lines.push({ text: line, time: -1 });
			result.synchronized = false;
		}
	}

	result.lines.sort((a, b) => a.time - b.time);
	if (!result.lines.some((l) => l.time >= 0)) result.synchronized = false;
	return result;
}
