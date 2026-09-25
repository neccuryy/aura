import { app, BrowserWindow, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";

// Auto-update via GitHub Releases: on start the packaged app checks the
// latest release; when a newer version is out the renderer shows a download
// button, and clicking it downloads + installs + relaunches.
export function initUpdater(getWin: () => BrowserWindow | null): void {
	if (!app.isPackaged) return; // dev instance — nothing to update

	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = true;

	const send = (channel: string, payload?: unknown): void => {
		const win = getWin();
		if (!win || win.isDestroyed()) return;
		win.webContents.send(channel, payload);
	};

	autoUpdater.on("update-available", (info) => {
		console.log(`[updater] update available: v${info.version} (current v${app.getVersion()})`);
		send("update-available", { version: info.version });
	});
	autoUpdater.on("update-not-available", () => console.log("[updater] up to date"));
	autoUpdater.on("error", (err) => console.log(`[updater] error: ${err && err.message ? err.message : err}`));

	autoUpdater.on("download-progress", (progress) => {
		send("update-progress", { percent: Math.round(progress.percent) });
	});
	autoUpdater.on("update-downloaded", () => {
		console.log("[updater] downloaded — installing and relaunching");
		send("update-installing");
		setTimeout(() => autoUpdater.quitAndInstall(), 200);
	});

	// the renderer sends (not invokes) — must be .on, not .handle, or the
	// click silently goes nowhere
	ipcMain.on("update:download", () => {
		console.log("[updater] download requested");
		void autoUpdater.downloadUpdate().catch((err) => {
			console.log(`[updater] download failed: ${err && err.message ? err.message : err}`);
			send("update-available", { version: autoUpdater.currentVersion.version }); // re-show the button
		});
	});

	void autoUpdater.checkForUpdates().catch((err) => {
		console.log(`[updater] check failed: ${err && err.message ? err.message : err}`);
	});
}
