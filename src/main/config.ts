import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export interface AuraConfig {
	musicFolders: string[];
	// Genius client access token — kept in config.json so it never lands
	// in the sources or in builds
	geniusToken?: string;
}

function configPath(): string {
	return path.join(app.getPath("userData"), "config.json");
}

export function loadConfig(): AuraConfig {
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
		const cfg: AuraConfig = {
			musicFolders: Array.isArray(parsed.musicFolders)
				? parsed.musicFolders.filter((x: unknown) => typeof x === "string")
				: []
		};
		if (typeof parsed.geniusToken === "string" && parsed.geniusToken)
			cfg.geniusToken = parsed.geniusToken;
		return cfg;
	} catch (_e) {
		// first run or unreadable config — fall through to defaults
	}
	return { musicFolders: [] };
}

export function saveConfig(config: AuraConfig): void {
	fs.mkdirSync(path.dirname(configPath()), { recursive: true });
	fs.writeFileSync(configPath(), JSON.stringify(config, null, "\t"));
}
