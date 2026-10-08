import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

// an app that ever held the current SMTC session — the settings'
// "Игнорировать" list is built from these, so the user never types paths
export interface SeenApp {
	// stable SMTC app id (AUMID / exe path) — the ignore match key
	app: string;
	// human-readable name ("Telegram Desktop") — what the list shows
	appName: string;
	lastSeen: number;
}

export interface AuraConfig {
	musicFolders: string[];
	// Genius client access token — kept in config.json so it never lands
	// in the sources or in builds
	geniusToken?: string;
	// SMTC app ids the app must not follow (messenger voice messages etc.)
	ignoredApps?: string[];
	// every app seen holding the current SMTC session, newest last
	seenApps: SeenApp[];
}

function loadSeenApps(parsed: unknown): SeenApp[] {
	if (!parsed || typeof parsed !== "object") return [];
	const raw = (parsed as Record<string, unknown>).seenApps;
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
		.filter((x) => typeof x.app === "string" && x.app)
		.map((x) => ({
			app: x.app as string,
			appName: typeof x.appName === "string" && x.appName ? x.appName : (x.app as string),
			lastSeen: typeof x.lastSeen === "number" ? x.lastSeen : 0
		}));
}

function loadStringArray(parsed: unknown, key: string): string[] {
	if (!parsed || typeof parsed !== "object") return [];
	const v = (parsed as Record<string, unknown>)[key];
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : [];
}

function configPath(): string {
	return path.join(app.getPath("userData"), "config.json");
}

export function loadConfig(): AuraConfig {
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
		const cfg: AuraConfig = {
			musicFolders: loadStringArray(parsed, "musicFolders"),
			ignoredApps: loadStringArray(parsed, "ignoredApps"),
			seenApps: loadSeenApps(parsed)
		};
		if (typeof parsed.geniusToken === "string" && parsed.geniusToken)
			cfg.geniusToken = parsed.geniusToken;
		return cfg;
	} catch (_e) {
		// first run or unreadable config — fall through to defaults
	}
	return { musicFolders: [], seenApps: [] };
}

export function saveConfig(config: AuraConfig): void {
	const file = configPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	// write via a temp file + rename: a crash mid-write must not corrupt
	// config.json (it holds the Genius token) — rename is atomic on NTFS
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(config, null, "\t"));
	fs.renameSync(tmp, file);
}
