"use strict";

const api = window.aura;

/* ---------- state ---------- */

const state = {
	lines: [],          // [{ text, time }]
	synchronized: false,
	hasTrack: false,
	playing: false,
	length: 0,
	basePos: 0,
	baseTs: 0,          // performance.now() of last position tick
	activeIndex: -1,
	userScrollTs: -1e9, // last manual scroll time
	wasInspect: false,
	seekTarget: null,   // expected position right after a local seek
	seekTs: 0,
	linesEl: null        // current lyrics wrapper
	,libraryEmpty: false // remembered for the "not found" note after search
	,lyricsOnline: false // current lyrics came from Lrclib/Genius (not a local .lrc)
	,lyricsLocal: false  // current lyrics came from a local .lrc file
	,sources: { entries: [], current: null, settled: false } // source switcher state
};

/* ---------- elements ---------- */

const el = {
	ambient: document.getElementById("ambient"),
	cover: document.getElementById("cover"),
	coverWrap: document.getElementById("cover-wrap"),
	coverPlaceholder: document.getElementById("cover-placeholder"),
	lyricsSource: document.getElementById("lyrics-source"),
	srcPrev: document.getElementById("src-prev"),
	srcName: document.getElementById("src-name"),
	srcNext: document.getElementById("src-next"),
	srcSizer: document.getElementById("src-sizer"),
	title: document.getElementById("track-title"),
	artist: document.getElementById("track-artist"),
	btnPrev: document.getElementById("btn-prev"),
	btnPlay: document.getElementById("btn-play"),
	btnNext: document.getElementById("btn-next"),
	iconPlay: document.getElementById("icon-play"),
	iconPause: document.getElementById("icon-pause"),
	seekbar: document.getElementById("seekbar"),
	seekfill: document.getElementById("seekfill"),
	timeCur: document.getElementById("time-cur"),
	timeTotal: document.getElementById("time-total"),
	lyrics: document.getElementById("lyrics"),
	btnWrongLyrics: document.getElementById("btn-wrong-lyrics"),
	settings: document.getElementById("settings"),
	folderList: document.getElementById("folder-list"),
	btnSettings: document.getElementById("btn-settings"),
	btnAddFolder: document.getElementById("btn-add-folder"),
	btnReindex: document.getElementById("btn-reindex"),
	indexStats: document.getElementById("index-stats"),
	cacheStats: document.getElementById("cache-stats"),
	btnClearCache: document.getElementById("btn-clear-cache"),
	geniusToken: document.getElementById("genius-token"),
	btnToggleToken: document.getElementById("btn-toggle-token"),
	iconEye: document.getElementById("icon-eye"),
	iconEyeOff: document.getElementById("icon-eye-off"),
	btnSaveToken: document.getElementById("btn-save-token"),
	tokenStatus: document.getElementById("token-status"),
	ignoreList: document.getElementById("ignore-list")
};

/* ---------- helpers ---------- */

function fmtTime(sec) {
	if (!isFinite(sec) || sec < 0) sec = 0;
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return m + ":" + String(s).padStart(2, "0");
}

function shade(hex, amount) {
	// amount: -1..1, negative = darker; always returns #rrggbb
	// (hex is required for the native title-bar overlay color)
	if (!hex) return null;
	const n = parseInt(hex.slice(1), 16);
	if (!isFinite(n)) return null;
	let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
	if (amount < 0) {
		const k = 1 + amount;
		r = Math.round(r * k); g = Math.round(g * k); b = Math.round(b * k);
	} else {
		r = Math.round(r + (255 - r) * amount);
		g = Math.round(g + (255 - g) * amount);
		b = Math.round(b + (255 - b) * amount);
	}
	const h = (v) => v.toString(16).padStart(2, "0");
	return "#" + h(r) + h(g) + h(b);
}

function applyPalette(palette) {
	const root = document.documentElement.style;
	const dm = palette?.darkMuted, dv = palette?.darkVibrant, v = palette?.vibrant;
	const bg1 = shade(dm, -0.35) || "#1c1917";
	const bg2 = shade(dv, -0.55) || "#141312";
	const accent = v || dv || dm || "#a78bfa";
	root.setProperty("--bg1", bg1);
	root.setProperty("--bg2", bg2);
	root.setProperty("--accent", accent);
	el.ambient.style.background =
		"radial-gradient(120% 120% at 20% 20%, " + bg1 + " 0%, " + bg2 + " 70%)";
	// fluid shader background: dark base + two accent tones from the cover
	if (window.FluidBg) {
		FluidBg.setColors(
			bg2,
			shade(accent, -0.15) || accent,
			shade(dv, -0.3) || bg1
		);
	}
}

/* ---------- lyrics rendering ---------- */

const USER_SCROLL_PAUSE = 4000; // ms: auto-centering pauses after manual scroll

function isInspecting() {
	return performance.now() - state.userScrollTs < USER_SCROLL_PAUSE;
}

function lineStyleForDistance(d) {
	// d < 0: already-sung lines above, d > 0: upcoming lines below.
	// the next line stays sharp so it can be read ahead of time
	if (d === 0) return { filter: "none", opacity: "1" };
	if (d === -1) return { filter: "blur(1px)", opacity: "0.55" };
	if (d === -2) return { filter: "blur(2px)", opacity: "0.3" };
	if (d === 1) return { filter: "none", opacity: "0.75" };
	if (d === 2) return { filter: "blur(1px)", opacity: "0.5" };
	return { filter: "none", opacity: "0.12" };
}

function resetLyricsPane() {
	el.lyrics.innerHTML = "";
	scrollAnim.active = false;
	el.lyrics.scrollTop = 0;
	const inner = document.createElement("div");
	inner.className = "lyrics-inner";
	el.lyrics.appendChild(inner);
	state.linesEl = inner;
	state.lines = [];
	state.activeIndex = -1;
	state.userScrollTs = -1e9;
	return inner;
}

// shown while the online lookup (Lrclib → Genius) is in flight
function showLyricsLoading() {
	const inner = resetLyricsPane();
	const div = document.createElement("div");
	div.className = "line placeholder";
	const dots = document.createElement("span");
	dots.className = "loader-dots";
	for (let i = 0; i < 3; i++) dots.appendChild(document.createElement("span"));
	div.appendChild(dots);
	inner.appendChild(div);
}

function renderLyrics(lyrics, libraryEmpty) {
	if (!lyrics) {
		const inner = resetLyricsPane();
		const div = document.createElement("div");
		div.className = "line placeholder";
		if (libraryEmpty) {
			div.textContent = "Папки с музыкой не указаны.\nНажми «Папки с музыкой» внизу слева\nи добавь папку со своими mp3 и .lrc.";
		} else {
			div.textContent = "Текст не найден: ни .lrc рядом с треком,\nни в онлайн-базах Lrclib и Genius.";
		}
		inner.appendChild(div);
		return;
	}

	if (lyrics.instrumental) {
		const inner = resetLyricsPane();
		const div = document.createElement("div");
		div.className = "line placeholder instrumental";
		div.textContent = "Инструментал";
		inner.appendChild(div);
		return;
	}

	// live alignment ("aura") re-delivers the same text with refined times
	// every few seconds — a full rebuild resets the scroll to the top and
	// teleports the view ("start → active line" on every tick). When the
	// text is unchanged, update in place: keep the DOM and the scroll
	// position, only the times (and thus the highlight) move
	if (
		state.linesEl && state.lines.length > 0 &&
		state.lines.length === lyrics.lines.length &&
		state.lines.every((l, i) => (l.text || "♪") === (lyrics.lines[i].text || "♪"))
	) {
		state.lines = lyrics.lines;
		state.synchronized = lyrics.synchronized;
		const children = state.linesEl.children;
		for (let i = 0; i < children.length; i++) {
			children[i].classList.toggle("clickable", state.synchronized && state.lines[i].time >= 0);
		}
		return;
	}

	const inner = resetLyricsPane();
	state.lines = lyrics.lines;
	state.synchronized = lyrics.synchronized;

	for (let i = 0; i < state.lines.length; i++) {
		const line = state.lines[i];
		const div = document.createElement("div");
		div.className = "line";
		div.textContent = line.text || "♪";
		if (state.synchronized && line.time >= 0) {
			div.classList.add("clickable");
			// read the time at click time: live alignment refreshes the
			// times in place, and a closure over `line` would seek to a
			// stale time
			div.addEventListener("click", () => seekTo(state.lines[i].time));
		}
		inner.appendChild(div);
	}
}

/* ---------- smooth auto-scroll ---------- */

// native behavior:"smooth" is jerky and uncontrollable — animate scrollTop
// ourselves inside the rAF loop with an ease, cancelable by the wheel
const scrollAnim = { active: false, from: 0, to: 0, start: 0, dur: 500 };

function easeInOutCubic(t) {
	return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function animateScrollTo(top) {
	scrollAnim.from = el.lyrics.scrollTop;
	scrollAnim.to = Math.max(0, top);
	const dist = Math.abs(scrollAnim.to - scrollAnim.from);
	if (dist < 2) {
		el.lyrics.scrollTop = scrollAnim.to;
		scrollAnim.active = false;
		return;
	}
	scrollAnim.start = performance.now();
	// longer hops take longer, capped so it never feels sluggish
	scrollAnim.dur = Math.min(800, 220 + dist * 0.35);
	scrollAnim.active = true;
}

function stepScrollAnim() {
	if (!scrollAnim.active) return;
	if (isInspecting()) {
		scrollAnim.active = false; // user took over — stop immediately
		return;
	}
	const t = Math.min(1, (performance.now() - scrollAnim.start) / scrollAnim.dur);
	el.lyrics.scrollTop =
		scrollAnim.from + (scrollAnim.to - scrollAnim.from) * easeInOutCubic(t);
	if (t >= 1) scrollAnim.active = false;
}

function scrollToCenter(node) {
	const top = node.offsetTop - el.lyrics.clientHeight / 2 + node.offsetHeight / 2;
	animateScrollTo(top);
}

function updateActiveLine(elapsed) {
	if (!state.synchronized || !state.lines.length) return;

	let idx = -1;
	for (let i = 0; i < state.lines.length; i++) {
		if (state.lines[i].time >= 0 && state.lines[i].time <= elapsed) idx = i;
	}

	const inspect = isInspecting();
	if (idx === state.activeIndex && inspect === state.wasInspect) return;

	const changed = idx !== state.activeIndex;
	state.activeIndex = idx;
	state.wasInspect = inspect;

	const children = state.linesEl.children;
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		child.classList.toggle("active", i === idx);
		child.classList.toggle("past", i < idx);
		if (idx < 0 || inspect) {
			child.style.filter = "";
			child.style.opacity = "";
		} else {
			const s = lineStyleForDistance(i - idx);
			child.style.filter = s.filter;
			child.style.opacity = s.opacity;
		}
	}
	if (!inspect && changed && idx >= 0 && children[idx]) {
		scrollToCenter(children[idx]);
	}
}

/* ---------- animation loop ---------- */

function tick() {
	stepScrollAnim();
	if (state.hasTrack) {
		let elapsed = state.basePos;
		if (state.playing) elapsed += (performance.now() - state.baseTs) / 1000;

		if (state.length > 0) {
			const pct = Math.min(100, Math.max(0, (elapsed / state.length) * 100));
			el.seekfill.style.width = pct + "%";
			el.timeCur.textContent = fmtTime(elapsed);
		}
		updateActiveLine(elapsed);
	}
	requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/* ---------- IPC events ---------- */

api.onTrack((data) => {
	state.hasTrack = !data.empty;

	if (data.empty) {
		el.title.textContent = "aura";
		el.artist.textContent = "Запусти трек в любом плеере";
		el.srcName.textContent = "";
		state.lyricsOnline = false;
		state.lyricsLocal = false;
		refreshLyricsButtons();
		document.getElementById("app").classList.add("idle");
		el.iconPlay.classList.remove("hidden");
		el.iconPause.classList.add("hidden");
		state.playing = false;
		state.basePos = 0;
		state.baseTs = performance.now();
		el.seekfill.style.width = "0%";
		el.timeCur.textContent = "0:00";
		el.timeTotal.textContent = "";
		renderLyrics(null, data.libraryEmpty);
		return;
	}

	document.getElementById("app").classList.remove("idle");

	el.title.textContent = data.title || "Неизвестный трек";
	el.artist.textContent = data.artist || data.appName || "";

	if (data.artUrl) {
		el.cover.src = data.artUrl;
		el.cover.style.display = "block";
		el.coverPlaceholder.classList.add("hidden");
	}
	// no artwork yet — keep whatever is on screen; a separate "art" event
	// will either deliver a cover or explicitly clear it
	if (data.palette) applyPalette(data.palette);

	state.length = data.length || 0;
	state.playing = (data.status || "").toLowerCase().includes("play") &&
		!(data.status || "").toLowerCase().includes("pause");
	state.basePos = 0;
	state.baseTs = performance.now();

	el.iconPlay.classList.toggle("hidden", state.playing);
	el.iconPause.classList.toggle("hidden", !state.playing);

	el.timeTotal.textContent = state.length > 0 ? fmtTime(state.length) : "";

	const caps = data.capabilities || {};
	el.btnPrev.disabled = caps.canGoPrevious === false;
	el.btnNext.disabled = caps.canGoNext === false;
	el.btnPlay.disabled = caps.canPlayPause === false;

	state.libraryEmpty = !!data.libraryEmpty;
	if (data.lyrics) {
		// local .lrc matched — show it immediately, badge = file name
		el.srcName.textContent = data.lrcSource || "локальный .lrc";
		state.lyricsOnline = false;
		state.lyricsLocal = true;
		renderLyrics(data.lyrics, data.libraryEmpty);
	} else {
		// online lookup is in flight — loader until the "lyrics" event lands
		el.srcName.textContent = "";
		state.lyricsOnline = false;
		state.lyricsLocal = false;
		showLyricsLoading();
	}
	refreshLyricsButtons();
});

// the first update after a track switch can carry the previous track's
// length — the corrected value arrives later and must reach the seekbar
// and the total-time label
api.onTrackLength((data) => {
	const len = data && typeof data.length === "number" ? data.length : 0;
	if (len > 0 && len !== state.length) {
		state.length = len;
		el.timeTotal.textContent = fmtTime(len);
	}
});

// online lyrics arrive after the track payload (background lookup):
// a result swaps the loader for lyrics, a miss swaps it for the note
api.onLyrics((data) => {
	if (!state.hasTrack) return;
	if (data && data.lyrics) {
		el.srcName.textContent = data.source || "";
		state.lyricsOnline = data.source === "Lrclib" || data.source === "Genius";
		state.lyricsLocal = false;
		renderLyrics(data.lyrics, false);
	} else {
		el.srcName.textContent = "";
		state.lyricsOnline = false;
		state.lyricsLocal = false;
		renderLyrics(null, state.libraryEmpty);
	}
	refreshLyricsButtons();
});

api.onArt((data) => {
	if (data.artUrl) {
		el.cover.src = data.artUrl;
		el.cover.style.display = "block";
		el.coverPlaceholder.classList.add("hidden");
		if (data.palette) applyPalette(data.palette);
	} else {
		el.cover.style.display = "none";
		el.coverPlaceholder.classList.remove("hidden");
	}
});

api.onStatus((data) => {
	state.playing = (data.status || "").toLowerCase().includes("play") &&
		!(data.status || "").toLowerCase().includes("pause");
	el.iconPlay.classList.toggle("hidden", state.playing);
	el.iconPause.classList.toggle("hidden", !state.playing);
	const caps = data.capabilities || {};
	el.btnPrev.disabled = caps.canGoPrevious === false;
	el.btnNext.disabled = caps.canGoNext === false;
	el.btnPlay.disabled = caps.canPlayPause === false;
});

api.onPosition((data) => {
	const pos = data.position || 0;
	// right after a local seek the player still reports the old position for
	// a while — ignore stale ticks until it catches up (or 3s timeout)
	if (state.seekTarget !== null) {
		const age = performance.now() - state.seekTs;
		if (age < 3000 && Math.abs(pos - state.seekTarget) > 2) return;
		state.seekTarget = null;
	}
	state.basePos = pos;
	state.baseTs = performance.now();
	state.playing = !!data.playing;
});

/* ---------- controls ---------- */

function seekTo(seconds) {
	// update local position immediately so the UI doesn't wait for the player
	state.basePos = seconds;
	state.baseTs = performance.now();
	state.seekTarget = seconds;
	state.seekTs = performance.now();
	api.seek(seconds);
}

el.btnPlay.addEventListener("click", () => api.playPause());
el.btnNext.addEventListener("click", () => api.next());
el.btnPrev.addEventListener("click", () => api.previous());

el.lyrics.addEventListener("wheel", () => {
	state.userScrollTs = performance.now();
	scrollAnim.active = false; // manual scroll cancels auto-centering
}, { passive: true });

el.seekbar.addEventListener("click", (e) => {
	if (state.length <= 0) return;
	const rect = el.seekbar.getBoundingClientRect();
	const pct = (e.clientX - rect.left) / rect.width;
	seekTo(Math.max(0, Math.min(1, pct)) * state.length);
});

/* ---------- settings ---------- */

function renderSettings(stats) {
	el.folderList.innerHTML = "";
	for (const folder of stats.folders) {
		const li = document.createElement("li");
		const name = document.createElement("span");
		name.textContent = folder;
		const rm = document.createElement("button");
		rm.className = "rm";
		rm.title = "Убрать";
		rm.textContent = "✕";
		rm.addEventListener("click", async () => {
			renderSettings(await api.removeFolder(folder));
		});
		li.appendChild(name);
		li.appendChild(rm);
		el.folderList.appendChild(li);
	}
	el.indexStats.textContent =
		"В библиотеке: " + stats.trackCount + " треков, с текстами (.lrc): " + stats.lrcCount;
}

function fmtBytes(bytes) {
	if (bytes < 1024) return bytes + " Б";
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " КБ";
	return (bytes / (1024 * 1024)).toFixed(1) + " МБ";
}

function renderCacheStats(stats) {
	el.cacheStats.textContent =
		stats.files + " " + plural(stats.files, ["файл", "файла", "файлов"]) + " · " + fmtBytes(stats.bytes);
}

function renderIgnoreList(data) {
	el.ignoreList.innerHTML = "";
	if (!data.apps.length) {
		const li = document.createElement("li");
		li.className = "empty";
		li.textContent = "Пока пусто — источники появятся, когда что-то заиграет";
		el.ignoreList.appendChild(li);
		return;
	}
	for (const a of data.apps) {
		const li = document.createElement("li");
		const name = document.createElement("span");
		name.className = "app-name";
		name.textContent = a.appName;
		const sw = document.createElement("button");
		sw.className = "switch";
		sw.setAttribute("role", "switch");
		sw.setAttribute("aria-checked", String(a.ignored));
		sw.title = a.ignored ? "Перестать игнорировать" : "Игнорировать этот источник";
		sw.addEventListener("click", async () => {
			renderIgnoreList(await api.toggleAppIgnore(a.app));
		});
		li.appendChild(name);
		li.appendChild(sw);
		el.ignoreList.appendChild(li);
	}
}

function plural(n, forms) {
	const n10 = n % 10;
	const n100 = n % 100;
	if (n10 === 1 && n100 !== 11) return forms[0];
	if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1];
	return forms[2];
}

el.btnSettings.addEventListener("click", async () => {
	renderSettings(await api.getConfig());
	renderCacheStats(await api.cacheStats());
	renderIgnoreList(await api.listApps());
	const t = await api.getToken();
	el.geniusToken.value = t.token;
	el.tokenStatus.textContent = t.token ? "Токен сохранён — Genius включён." : "";
	el.settings.classList.remove("hidden");
	// the modal covers the whole window — freeze the fluid background so
	// its software-rendered blur doesn't starve the modal's own animations
	if (window.FluidBg) window.FluidBg.pause();
});

el.btnAddFolder.addEventListener("click", async () => {
	renderSettings(await api.pickFolder());
});

el.btnReindex.addEventListener("click", async () => {
	renderSettings(await api.reindex());
});

el.btnClearCache.addEventListener("click", async () => {
	renderCacheStats(await api.clearCache());
	// the current track's verdict was wiped too — if its text came from the
	// online chain, the whole lookup restarts; show the loader until it lands
	if (state.hasTrack && !state.lyricsLocal) {
		el.srcName.textContent = "";
		showLyricsLoading();
	}
});

el.btnSaveToken.addEventListener("click", async () => {
	const res = await api.setToken(el.geniusToken.value);
	el.geniusToken.value = res.token;
	el.tokenStatus.textContent = res.token
		? "Сохранено — Genius включён."
		: "Токен убран — Genius выключен.";
	// the token just appeared — if the current track found nothing without
	// it, re-run the search now that Genius is available
	if (res.token && state.hasTrack && !state.lines.length) {
		el.srcName.textContent = "";
		showLyricsLoading();
		api.retryLyrics();
	}
});

// the token field is masked by default; the eye toggles plain text
el.btnToggleToken.addEventListener("click", () => {
	const show = el.geniusToken.type === "password";
	el.geniusToken.type = show ? "text" : "password";
	el.iconEye.classList.toggle("hidden", show);
	el.iconEyeOff.classList.toggle("hidden", !show);
	el.btnToggleToken.title = show ? "Скрыть токен" : "Показать токен";
});

/* ---------- collapsible settings sections ---------- */

// measured max-height accordion: pin the real height before collapsing so
// the animation runs from the actual size, and clear it after opening so
// the content can grow (folder list) without clipping
function setSectionCollapsed(section, collapsed) {
	const body = section.querySelector(".section-body");
	if (collapsed) {
		body.style.maxHeight = body.scrollHeight + "px";
		void body.offsetHeight; // commit the pinned height before animating to 0
		body.style.maxHeight = "0px";
	} else {
		body.style.maxHeight = body.scrollHeight + "px";
		body.addEventListener("transitionend", function onEnd(e) {
			body.removeEventListener("transitionend", onEnd);
			// fully open — let the content grow freely from here
			if (e.propertyName === "max-height" && body.style.maxHeight !== "0px") {
				body.style.maxHeight = "";
			}
		});
	}
	section.classList.toggle("collapsed", collapsed);
}

for (const head of document.querySelectorAll(".section-head")) {
	head.addEventListener("click", () => {
		const section = head.closest(".settings-section");
		setSectionCollapsed(section, !section.classList.contains("collapsed"));
	});
}

el.settings.addEventListener("click", (e) => {
	if (e.target === el.settings) {
		el.settings.classList.add("hidden");
		if (window.FluidBg) window.FluidBg.resume();
	}
});

/* ---------- side buttons ---------- */

// retry is only meaningful without a local .lrc (a local file is what it
// is); "wrong lyrics" is only meaningful for online lyrics
function refreshLyricsButtons() {
	el.btnRetry.classList.toggle("hidden", !state.hasTrack || state.lyricsLocal);
	el.btnWrongLyrics.classList.toggle("hidden", !(state.hasTrack && state.lyricsOnline));
}

el.btnRetry = document.getElementById("btn-retry");

el.btnRetry.addEventListener("click", () => {
	showLyricsLoading();
	api.retryLyrics();
});

el.btnWrongLyrics.addEventListener("click", () => {
	showLyricsLoading();
	api.wrongLyrics();
});

/* ---------- fullscreen ---------- */

el.btnFullscreen = document.getElementById("btn-fullscreen");

el.btnFullscreen.addEventListener("click", () => {
	api.toggleFullscreen();
});

document.addEventListener("keydown", (e) => {
	if (e.key === "F11") {
		e.preventDefault();
		api.toggleFullscreen();
	}
});

api.onFullscreen((data) => {
	document.body.classList.toggle("fullscreen", !!data);
});

/* ---------- custom window controls ---------- */

// renderer-drawn minimize / maximize / close — the native overlay was a
// solid-color strip that stood out against the animated background
el.winMin = document.getElementById("win-min");
el.winMax = document.getElementById("win-max");
el.winClose = document.getElementById("win-close");
el.iconWinMax = document.getElementById("icon-win-max");
el.iconWinRestore = document.getElementById("icon-win-restore");

el.winMin.addEventListener("click", () => api.winControl("minimize"));
el.winMax.addEventListener("click", () => api.winControl("maximize"));
el.winClose.addEventListener("click", () => api.winControl("close"));

api.onWinMaximized((maximized) => {
	el.iconWinMax.classList.toggle("hidden", maximized);
	el.iconWinRestore.classList.toggle("hidden", !maximized);
	el.winMax.title = maximized ? "Восстановить" : "Развернуть";
});

/* ---------- auto-update ---------- */

// the packaged app checks GitHub Releases on start; when a newer version
// is out, a pulsing download button appears in the side panel — clicking
// it downloads the update (percent shown right in the button) and
// relaunches the app on the new version
el.btnUpdate = document.getElementById("btn-update");
el.updateIcon = el.btnUpdate.querySelector("svg");

el.btnUpdate.addEventListener("click", () => {
	if (el.btnUpdate.classList.contains("downloading")) return;
	el.btnUpdate.classList.add("downloading");
	el.btnUpdate.title = "Скачивается обновление…";
	api.downloadUpdate();
});

api.onUpdateAvailable((data) => {
	if (el.btnUpdate.classList.contains("downloading")) return;
	el.btnUpdate.classList.remove("hidden");
	el.btnUpdate.title = `Доступна версия ${data && data.version ? data.version : "новее"} — скачать`;
});

api.onUpdateProgress((data) => {
	if (!el.btnUpdate.classList.contains("downloading")) {
		el.btnUpdate.classList.add("downloading");
	}
	const percent = data && typeof data.percent === "number" ? data.percent : 0;
	if (percent > 0) {
		el.updateIcon.classList.add("hidden");
		el.btnUpdate.textContent = `${percent}%`;
	}
});

api.onUpdateInstalling(() => {
	el.btnUpdate.textContent = "…";
	el.btnUpdate.title = "Устанавливается — приложение перезапустится";
});

// a failed download must not leave the button stuck at "NN%" — restore
// the icon (setting textContent detached it) so the user can retry
api.onUpdateError(() => {
	if (!el.btnUpdate.classList.contains("downloading")) return;
	el.btnUpdate.classList.remove("downloading");
	el.btnUpdate.textContent = "";
	el.btnUpdate.appendChild(el.updateIcon);
	el.updateIcon.classList.remove("hidden");
	el.btnUpdate.title = "Не удалось скачать — попробовать ещё раз";
});

/* ---------- lyrics source badge ---------- */

// the badge above the cover stays invisible; hovering the cover (or the
// badge itself) reveals where the current lyrics came from
el.coverWrap.addEventListener("mouseenter", () => {
	el.lyricsSource.classList.add("visible");
});
el.coverWrap.addEventListener("mouseleave", () => {
	el.lyricsSource.classList.remove("visible");
});

/* ---------- source switcher ---------- */

// "< AURA >" — arrows cycle through every lyrics source the main process
// found for the track (local .lrc / Lrclib / Genius / aura alignment).
// Arrows appear only after the search settled AND more than one source is
// ready; sources that load late (after retries) join the list as they land.
function readySources() {
	return state.sources.entries.filter((e) => e.status === "ready");
}

function renderSourceSwitcher() {
	const show = state.sources.settled && readySources().length > 1;
	el.srcPrev.classList.toggle("hidden", !show);
	el.srcNext.classList.toggle("hidden", !show);
	// size the name slot by the longest source name (e.g. "GENIUS") so the
	// arrows sit right next to it and never move on switching; names are
	// never abbreviated — the slot always fits the longest one entirely
	// (getBoundingClientRect is fractional; ceil + slack so rounding never
	// clips the longest name)
	let w = 0;
	for (const e of state.sources.entries) {
		el.srcSizer.textContent = e.name || "";
		const tw = el.srcSizer.getBoundingClientRect().width;
		if (tw > w) w = tw;
	}
	el.srcSizer.textContent = "";
	el.srcName.style.width = w > 0 ? Math.ceil(w) + 2 + "px" : "";
}

function cycleSource(dir) {
	const ready = readySources();
	if (ready.length < 2) return;
	let idx = ready.findIndex((e) => e.id === state.sources.current);
	if (idx < 0) idx = 0;
	api.selectSource(ready[(idx + dir + ready.length) % ready.length].id);
}

el.srcPrev.addEventListener("click", () => cycleSource(-1));
el.srcNext.addEventListener("click", () => cycleSource(1));

api.onSources((data) => {
	state.sources = {
		entries: (data && data.entries) || [],
		current: (data && data.current) || null,
		settled: !!(data && data.settled)
	};
	const cur = state.sources.entries.find((e) => e.id === state.sources.current);
	if (cur) el.srcName.textContent = cur.name;
	renderSourceSwitcher();
});
