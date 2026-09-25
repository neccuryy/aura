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
};

/* ---------- elements ---------- */

const el = {
	ambient: document.getElementById("ambient"),
	cover: document.getElementById("cover"),
	coverWrap: document.getElementById("cover-wrap"),
	coverPlaceholder: document.getElementById("cover-placeholder"),
	lyricsSource: document.getElementById("lyrics-source"),
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
	btnCloseSettings: document.getElementById("btn-close-settings"),
	indexStats: document.getElementById("index-stats")
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
	// recolor the native window-controls overlay to blend with the background
	if (api.setTitlebarColor) api.setTitlebarColor(bg2, "#f5f5f4");
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
	const inner = resetLyricsPane();

	if (!lyrics) {
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
		const div = document.createElement("div");
		div.className = "line placeholder instrumental";
		div.textContent = "Инструментал";
		inner.appendChild(div);
		return;
	}

	state.lines = lyrics.lines;
	state.synchronized = lyrics.synchronized;

	for (const line of state.lines) {
		const div = document.createElement("div");
		div.className = "line";
		div.textContent = line.text || "♪";
		if (state.synchronized && line.time >= 0) {
			div.classList.add("clickable");
			div.addEventListener("click", () => seekTo(line.time));
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
		el.lyricsSource.textContent = "";
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
		el.lyricsSource.textContent = data.lrcSource || "локальный .lrc";
		state.lyricsOnline = false;
		state.lyricsLocal = true;
		renderLyrics(data.lyrics, data.libraryEmpty);
	} else {
		// online lookup is in flight — loader until the "lyrics" event lands
		el.lyricsSource.textContent = "";
		state.lyricsOnline = false;
		state.lyricsLocal = false;
		showLyricsLoading();
	}
	refreshLyricsButtons();
});

// online lyrics arrive after the track payload (background lookup):
// a result swaps the loader for lyrics, a miss swaps it for the note
api.onLyrics((data) => {
	if (!state.hasTrack) return;
	if (data && data.lyrics) {
		el.lyricsSource.textContent = data.source || "";
		state.lyricsOnline = data.source === "Lrclib" || data.source === "Genius";
		state.lyricsLocal = false;
		renderLyrics(data.lyrics, false);
	} else {
		el.lyricsSource.textContent = "";
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

el.btnSettings.addEventListener("click", async () => {
	renderSettings(await api.getConfig());
	el.settings.classList.remove("hidden");
});

el.btnCloseSettings.addEventListener("click", () => el.settings.classList.add("hidden"));

el.btnAddFolder.addEventListener("click", async () => {
	renderSettings(await api.pickFolder());
});

el.btnReindex.addEventListener("click", async () => {
	renderSettings(await api.reindex());
});

el.settings.addEventListener("click", (e) => {
	if (e.target === el.settings) el.settings.classList.add("hidden");
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

/* ---------- lyrics source badge ---------- */

// the badge above the cover stays invisible; hovering the cover (or the
// badge itself) reveals where the current lyrics came from
el.coverWrap.addEventListener("mouseenter", () => {
	el.lyricsSource.classList.add("visible");
});
el.coverWrap.addEventListener("mouseleave", () => {
	el.lyricsSource.classList.remove("visible");
});
