import { contextBridge, ipcRenderer } from "electron";

const api = {
	getConfig: (): Promise<{ folders: string[]; trackCount: number; lrcCount: number }> =>
		ipcRenderer.invoke("get-config"),
	pickFolder: (): Promise<{ folders: string[]; trackCount: number; lrcCount: number }> =>
		ipcRenderer.invoke("pick-folder"),
	removeFolder: (folder: string): Promise<{ folders: string[]; trackCount: number; lrcCount: number }> =>
		ipcRenderer.invoke("remove-folder", folder),
	reindex: (): Promise<{ folders: string[]; trackCount: number; lrcCount: number }> =>
		ipcRenderer.invoke("reindex"),
	onTrack: (cb: (data: unknown) => void): void => {
		ipcRenderer.on("track", (_e, data) => cb(data));
	},
	onArt: (cb: (data: unknown) => void): void => {
		ipcRenderer.on("art", (_e, data) => cb(data));
	},
	onStatus: (cb: (data: unknown) => void): void => {
		ipcRenderer.on("status", (_e, data) => cb(data));
	},
	onPosition: (cb: (data: unknown) => void): void => {
		ipcRenderer.on("position", (_e, data) => cb(data));
	},
	onLyrics: (cb: (data: unknown) => void): void => {
		ipcRenderer.on("lyrics", (_e, data) => cb(data));
	},
	wrongLyrics: (): void => ipcRenderer.send("lyrics:wrong"),
	retryLyrics: (): void => ipcRenderer.send("lyrics:retry"),
	playPause: (): void => ipcRenderer.send("control", "playpause"),
	next: (): void => ipcRenderer.send("control", "next"),
	previous: (): void => ipcRenderer.send("control", "previous"),
	seek: (seconds: number): void => ipcRenderer.send("control:seek", seconds),
	toggleFullscreen: (): void => ipcRenderer.send("control:fullscreen"),
	setTitlebarColor: (color: string, symbolColor: string): void =>
		ipcRenderer.send("titlebar", { color, symbolColor }),
	onFullscreen: (cb: (data: unknown) => void): void => {
		ipcRenderer.on("fullscreen", (_e, data) => cb(data));
	},
	onUpdateAvailable: (cb: (data: unknown) => void): void => {
		ipcRenderer.on("update-available", (_e, data) => cb(data));
	},
	onUpdateProgress: (cb: (data: unknown) => void): void => {
		ipcRenderer.on("update-progress", (_e, data) => cb(data));
	},
	onUpdateInstalling: (cb: () => void): void => {
		ipcRenderer.on("update-installing", (_e) => cb());
	},
	downloadUpdate: (): void => ipcRenderer.send("update:download")
};

contextBridge.exposeInMainWorld("aura", api);

export type AuraApi = typeof api;
