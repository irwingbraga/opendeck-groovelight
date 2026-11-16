// Groovelight for OpenDeck: transport keys, a now playing key, keys that play a playlist, album or artist, and the
// Album of the Day.
//
// One Node.js process, no dependencies. It talks to OpenDeck over the OpenAction websocket and to Groovelight through
// its control channel: the `groovelight` command line tool on the Mac (the app is sandboxed and listens on a Mach
// port), the app's named pipe on Windows.

"use strict";

const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const PREFIX = "dev.irwingbraga.groovelight.deck.";
const ACTIONS = {
	playPause: PREFIX + "playpause",
	next: PREFIX + "next",
	previous: PREFIX + "previous",
	nowPlaying: PREFIX + "nowplaying",
	play: PREFIX + "play",
	today: PREFIX + "today",
};
const POLL_MS = 1000;
const TODAY_REFRESH_MS = 10 * 60 * 1000;
const SIZE = 144;

// Optional overrides for development, in local.json next to this file: {"cli": "/path/to/groovelight", "pipe": "name"}.
const local = (() => {
	try {
		return JSON.parse(fs.readFileSync(path.join(__dirname, "local.json"), "utf8"));
	} catch {
		return {};
	}
})();

function log(...args) {
	console.log(new Date().toISOString(), ...args);
}

// ------------------------------------------------------------------ Groovelight ---

/** Requests, in the app's JSON form ({type: "nowPlaying"}, {type: "playback", action: "toggle"}...). */
const groovelight = process.platform === "win32" ? windowsClient() : macClient();

function macClient() {
	const candidates = [
		local.cli,
		process.env.GROOVELIGHT_CLI,
		"/Applications/Groovelight.app/Contents/Helpers/groovelight",
		path.join(os.homedir(), "Applications/Groovelight.app/Contents/Helpers/groovelight"),
		"/usr/local/bin/groovelight",
	].filter(Boolean);
	const cli = () => candidates.find((file) => fs.existsSync(file));

	/** The tool's arguments for a request. */
	function args(request) {
		switch (request.type) {
			case "nowPlaying": return ["now-playing"];
			case "artwork": return ["artwork", String(request.songId)];
			case "today": return ["today"];
			case "listPlaylists": return ["playlists"];
			case "search": return ["search", "--limit", String(request.limit ?? 20), "--", ...request.query.split(/\s+/).filter(Boolean)];
			case "playback": return [{ toggle: "play-pause" }[request.action] ?? request.action];
			case "play": {
				const o = request.options;
				const list = ["play"];
				if (o.songIds?.length) list.push("--songs", ...o.songIds.map(String));
				if (o.playlist) list.push("--playlist", o.playlist);
				if (o.album) list.push("--album", o.album);
				if (o.artist) list.push("--artist", o.artist);
				if (o.song) list.push("--song", o.song);
				if (o.shuffle) list.push("--shuffle");
				if (o.query) list.push("--", ...o.query.split(/\s+/).filter(Boolean));
				return list;
			}
			default: throw new Error(`unknown request ${request.type}`);
		}
	}

	return {
		/** Whether the app is running (asking the tool would start it). */
		isRunning() {
			return new Promise((resolve) => execFile("/usr/bin/pgrep", ["-x", "Groovelight"], (error) => resolve(!error)));
		},
		/** Sends a request; the tool starts the app when it is not running. Resolves to {data} or {error}. */
		send(request) {
			const file = cli();
			if (!file) return Promise.resolve({ error: "Groovelight is not installed." });
			return new Promise((resolve) => {
				const [command, ...rest] = args(request);
				execFile(file, [command, "--json", ...rest], { timeout: 45000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
					let parsed;
					try {
						parsed = JSON.parse(stdout);
					} catch {
						return resolve({ error: (stderr || error?.message || "No answer from Groovelight.").trim() });
					}
					// Errors come as {data, error}; results as the data itself.
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed && Object.keys(parsed).every((k) => k === "data" || k === "error")) {
						return resolve({ error: parsed.error, data: parsed.data });
					}
					resolve({ data: parsed });
				});
			});
		},
	};
}

function windowsClient() {
	// The app's pipe for the default library: Groovelight.Control.<user>.<first 16 hex digits of SHA-256 of "">.
	const name = local.pipe || process.env.GROOVELIGHT_PORT ||
		`Groovelight.Control.${process.env.USERNAME || os.userInfo().username}.${crypto.createHash("sha256").update("").digest("hex").slice(0, 16).toUpperCase()}`;
	const pipe = `\\\\.\\pipe\\${name}`;
	const app = local.app || path.join(process.env.LOCALAPPDATA || "", "Groovelight", "current", "Groovelight.exe");

	function exchange(request, timeout = 30000) {
		return new Promise((resolve) => {
			let buffer = "";
			let settled = false;
			const finish = (value) => {
				if (settled) return;
				settled = true;
				socket.destroy();
				resolve(value);
			};
			const socket = net.connect(pipe, () => socket.write(JSON.stringify({ version: 1, request }) + "\n"));
			socket.setEncoding("utf8");
			socket.setTimeout(timeout, () => finish({ error: "Groovelight did not answer in time.", offline: false }));
			socket.on("data", (chunk) => {
				buffer += chunk;
				const end = buffer.indexOf("\n");
				if (end < 0) return;
				try {
					const reply = JSON.parse(buffer.slice(0, end));
					finish(reply.error ? { error: reply.error, data: reply.data } : { data: reply.data ?? null });
				} catch {
					finish({ error: "Groovelight sent a reply this plugin cannot read." });
				}
			});
			socket.on("error", () => finish({ error: "Groovelight is not running.", offline: true }));
			socket.on("end", () => finish({ error: "Groovelight closed the connection.", offline: false }));
		});
	}

	async function start() {
		if (!fs.existsSync(app)) return false;
		spawn(app, [], { detached: true, stdio: "ignore", windowsHide: false }).unref();
		const deadline = Date.now() + 30000;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 300));
			const reply = await exchange({ type: "status" }, 2000);
			if (!reply.offline) return true;
		}
		return false;
	}

	return {
		async isRunning() {
			return !(await exchange({ type: "status" }, 2000)).offline;
		},
		async send(request) {
			let reply = await exchange(request);
			// Like the command line tool: start the app for anything but a look at its state.
			if (reply.offline && !["nowPlaying", "artwork"].includes(request.type) && (await start())) reply = await exchange(request);
			return reply;
		},
	};
}

// ------------------------------------------------------------------------ State ---

const keys = new Map(); // context -> {action, settings}
const sent = new Map(); // context -> the last image sent
const covers = new Map(); // song id -> data URI (or null: no cover)
let playing = null; // the app's now playing result, null: nothing, undefined: not running
let today = null; // {fetched, picks}
let socket;

async function cover(songId) {
	if (songId == null) return null;
	if (covers.has(songId)) return covers.get(songId);
	const reply = await groovelight.send({ type: "artwork", songId });
	// An app without covers (before 0.9.7) answers with an error: remember there is none.
	const uri = reply.data?.base64 ? `data:${reply.data.mime || "image/jpeg"};base64,${reply.data.base64}` : null;
	if (covers.size > 200) covers.clear();
	covers.set(songId, uri);
	return uri;
}

async function poll() {
	const needed = [...keys.values()].some((k) => k.action === ACTIONS.playPause || k.action === ACTIONS.nowPlaying);
	if (!needed) return;
	if (!(await groovelight.isRunning())) {
		setPlaying(undefined);
		return;
	}
	const reply = await groovelight.send({ type: "nowPlaying" });
	if (!reply.error) setPlaying(reply.data ?? null);
}

function setPlaying(value) {
	const before = JSON.stringify(summary(playing));
	playing = value;
	if (JSON.stringify(summary(playing)) !== before) redraw((k) => k.action === ACTIONS.playPause || k.action === ACTIONS.nowPlaying);
}

/** What the keys show of now playing (not the position, which changes every second). */
function summary(p) {
	return p === undefined ? "off" : p && { id: p.id, state: p.state, title: p.title, artist: p.artist, artwork: p.artwork };
}

async function loadToday(force = false) {
	if (!force && today && Date.now() - today.fetched < TODAY_REFRESH_MS && new Date(today.fetched).toDateString() === new Date().toDateString()) return today;
	if (!(await groovelight.isRunning())) return null;
	const reply = await groovelight.send({ type: "today" });
	if (reply.error) return today;
	today = { fetched: Date.now(), picks: reply.data?.picks ?? [] };
	return today;
}

// ------------------------------------------------------------------- Rendering ---

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif`;
const ACCENT = "#ff9f43";

/** Rough text width (no font metrics here): wide letters count more. */
function width(text, size) {
	let units = 0;
	for (const c of text) units += /[MWmw@]/.test(c) ? 0.85 : /[A-Z0-9]/.test(c) ? 0.66 : /[iljtfr.,:;'|! ]/.test(c) ? 0.3 : c.charCodeAt(0) > 0x2e7f ? 1 : 0.54;
	return units * size;
}

/** Lines of at most `max` width, breaking at spaces, the last one cut with an ellipsis. */
function wrap(text, size, max, lines) {
	const words = String(text ?? "").split(/\s+/).filter(Boolean);
	const out = [];
	let line = "";
	for (const word of words) {
		const trial = line ? `${line} ${word}` : word;
		if (width(trial, size) <= max || !line) line = trial;
		else {
			out.push(line);
			line = word;
		}
	}
	if (line) out.push(line);
	const cut = out.slice(0, lines);
	if (out.length > lines || cut.some((l) => width(l, size) > max)) {
		let last = out.length > lines ? cut[lines - 1] + "…" : cut[cut.length - 1];
		while (last.length > 1 && width(last, size) > max) last = last.slice(0, -2) + "…";
		cut[cut.length - 1] = last;
		for (let i = 0; i < cut.length - 1; i++) {
			while (cut[i].length > 1 && width(cut[i], size) > max) cut[i] = cut[i].slice(0, -2) + "…";
		}
	}
	return cut;
}

function svg(body) {
	const doc = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${body}</svg>`;
	return "data:image/svg+xml;base64," + Buffer.from(doc).toString("base64");
}

function text(lines, { y, size, weight = 600, fill = "#fff", lineHeight = size * 1.2, anchor = "middle", x = SIZE / 2 }) {
	return lines.map((line, i) =>
		`<text x="${x}" y="${y + i * lineHeight}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(line)}</text>`).join("");
}

const ICONS = {
	play: `<path d="M-14 -20 L22 0 L-14 20 Z"/>`,
	pause: `<rect x="-17" y="-20" width="12" height="40" rx="3"/><rect x="5" y="-20" width="12" height="40" rx="3"/>`,
	note: `<path d="M-6 -22 L18 -27 L18 10 A8 7 0 1 1 12 3.5 L12 -18 L0 -15.5 L0 15 A8 7 0 1 1 -6 8.5 Z"/>`,
	playlist: `<rect x="-22" y="-18" width="30" height="5" rx="2"/><rect x="-22" y="-6" width="30" height="5" rx="2"/><rect x="-22" y="6" width="18" height="5" rx="2"/><path d="M8 2 L24 11 L8 20 Z"/>`,
	album: `<circle r="22" fill="none" stroke="currentColor" stroke-width="5"/><circle r="6"/>`,
	artist: `<circle cy="-9" r="11"/><path d="M-21 22 A21 17 0 0 1 21 22 Z"/>`,
	song: `<path d="M-6 -22 L18 -27 L18 10 A8 7 0 1 1 12 3.5 L12 -18 L0 -15.5 L0 15 A8 7 0 1 1 -6 8.5 Z"/>`,
	off: `<circle r="20" fill="none" stroke="currentColor" stroke-width="5"/><path d="M-14 14 L14 -14" stroke="currentColor" stroke-width="5"/>`,
};

function icon(name, { x = SIZE / 2, y = SIZE / 2, scale = 1, fill = "#fff" } = {}) {
	return `<g transform="translate(${x} ${y}) scale(${scale})" fill="${fill}" color="${fill}">${ICONS[name]}</g>`;
}

/** The cover filling the key, or a dark gradient in its place. */
function background(uri, dim = 0) {
	const base = uri
		? `<image x="0" y="0" width="${SIZE}" height="${SIZE}" preserveAspectRatio="xMidYMid slice" href="${uri}" xlink:href="${uri}"/>`
		: `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3a2a4d"/><stop offset="1" stop-color="#14121c"/></linearGradient></defs><rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>`;
	return base + (dim ? `<rect width="${SIZE}" height="${SIZE}" fill="#000" opacity="${dim}"/>` : "");
}

/** A label over the bottom of a cover. */
function caption(title, subtitle) {
	// A title that fits on one line keeps the bigger size; a longer one takes two smaller lines.
	const oneLine = width(String(title ?? ""), 19) <= SIZE - 14;
	const size = oneLine ? 19 : 17;
	const lineHeight = size + 2;
	const t = wrap(title, size, SIZE - 12, oneLine ? 1 : 2);
	const s = subtitle ? wrap(subtitle, 14, SIZE - 14, 1) : [];
	const height = 12 + t.length * lineHeight + s.length * 17;
	return `<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="0.4" stop-color="#000" stop-opacity="0.72"/><stop offset="1" stop-color="#000" stop-opacity="0.88"/></linearGradient></defs>` +
		`<rect x="0" y="${SIZE - height - 18}" width="${SIZE}" height="${height + 18}" fill="url(#fade)"/>` +
		text(t, { y: SIZE - height + size, size, weight: 700, lineHeight }) +
		text(s, { y: SIZE - 9, size: 14, weight: 500, fill: "#ddd" });
}

function badge(name) {
	return `<circle cx="${SIZE - 24}" cy="24" r="17" fill="#000" opacity="0.6"/>` + icon(name, { x: SIZE - 24, y: 24, scale: 0.42 });
}

function offImage(label) {
	return svg(background(null) + icon("off", { y: 56, scale: 0.9, fill: "#8a8494" }) + text(wrap(label, 17, SIZE - 16, 2), { y: 112, size: 17, fill: "#b9b3c4" }));
}

async function renderPlayPause() {
	if (playing === undefined) return offImage("Groovelight");
	const isPlaying = playing?.state === "playing";
	const uri = playing ? await cover(playing.id) : null;
	return svg(background(uri, uri ? 0.5 : 0) + icon(isPlaying ? "pause" : "play", { scale: 1.25 }));
}

async function renderNowPlaying() {
	if (playing === undefined) return offImage("Groovelight");
	if (!playing) return svg(background(null) + icon("note", { y: 58, scale: 1.1, fill: "#cfc6dd" }) + text(["Nothing playing"], { y: 118, size: 16, fill: "#cfc6dd" }));
	const uri = await cover(playing.id);
	return svg(background(uri) + (uri ? "" : icon("note", { y: 50, scale: 1.1, fill: "#cfc6dd" })) +
		caption(playing.title, playing.artist) + (playing.state === "playing" ? "" : badge("pause")));
}

/** A play key: the cover of what it plays (an album, or the first song found), else an icon for its kind. */
async function renderPlay(settings) {
	const kind = settings.kind || "playlist";
	const name = { playlist: settings.playlist, album: settings.album, artist: settings.artist, search: settings.query }[kind];
	const label = settings.label || name;
	if (!name) return svg(background(null) + icon(kind === "search" ? "song" : kind, { y: 58, fill: "#cfc6dd" }) + text(["Choose in", "settings"], { y: 106, size: 15, fill: "#cfc6dd" }));
	const uri = settings.showCover === false ? null : await playCover(settings);
	const kindLabel = { playlist: "Playlist", album: "Album", artist: "Artist", search: "Play" }[kind];
	if (uri) return svg(background(uri) + caption(label) + (settings.shuffle ? shuffleBadge() : ""));
	return svg(background(null) + icon(kind === "search" ? "song" : kind, { y: 46, scale: 0.95, fill: ACCENT }) +
		text(wrap(label, 18, SIZE - 14, 2), { y: 96, size: 18, weight: 700 }) +
		text([kindLabel + (settings.shuffle ? ", shuffled" : "")], { y: 134, size: 13, weight: 500, fill: "#a9a1b6" }) );
}

function shuffleBadge() {
	return `<circle cx="${SIZE - 22}" cy="22" r="15" fill="#000" opacity="0.6"/>` +
		`<g transform="translate(${SIZE - 22} 22)" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><path d="M-8 -5 H-4 L4 5 H8 M-8 5 H-4 L4 -5 H8"/><path d="M5 -8 L8 -5 L5 -2 M5 2 L8 5 L5 8"/></g>`;
}

const playCovers = new Map(); // settings key -> data URI or null
async function playCover(settings) {
	const id = JSON.stringify([settings.kind, settings.playlist, settings.album, settings.artist, settings.query]);
	if (playCovers.has(id)) return playCovers.get(id);
	if (!(await groovelight.isRunning())) return null;
	let songId = null;
	const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
	if (settings.kind === "album" || settings.kind === "artist" || settings.kind === "search") {
		const query = settings.kind === "search" ? settings.query : [settings.album, settings.artist].filter(Boolean).join(" ");
		const reply = await groovelight.send({ type: "search", query, limit: 25 });
		const songs = reply.data?.songs ?? [];
		const match = songs.find((s) =>
			(settings.kind !== "album" || fold(s.album).includes(fold(settings.album))) &&
			(settings.kind === "search" || !settings.artist || fold(s.albumArtist || s.artist).includes(fold(settings.artist)) || fold(s.artist).includes(fold(settings.artist))));
		songId = match?.id ?? null;
	}
	const uri = songId == null ? null : await cover(songId);
	playCovers.set(id, uri);
	return uri;
}

async function renderToday(settings) {
	const kind = settings.pick || "album";
	const title = { song: "Song of the Day", album: "Album of the Day", artist: "Artist of the Day" }[kind];
	const data = await loadToday();
	if (!data) return offImage(title);
	const pick = data.picks.find((p) => p.kind === kind);
	if (!pick) return svg(background(null) + text(wrap(title, 16, SIZE - 14, 2), { y: 60, size: 16, fill: "#cfc6dd" }) + text(["No pick yet"], { y: 104, size: 14, fill: "#a9a1b6" }));
	const uri = await cover(pick.song_ids?.[0]);
	const top = `<rect width="${SIZE}" height="26" fill="#000" opacity="0.55"/>` + text([title.toUpperCase()], { y: 18, size: 10.5, weight: 700, fill: ACCENT });
	return svg(background(uri) + (uri ? "" : icon(kind, { y: 62, fill: "#cfc6dd" })) + top + caption(pick.title, kind === "artist" ? null : pick.subtitle));
}

async function draw(context) {
	const key = keys.get(context);
	if (!key) return;
	let image;
	try {
		switch (key.action) {
			case ACTIONS.playPause: image = await renderPlayPause(); break;
			case ACTIONS.nowPlaying: image = await renderNowPlaying(); break;
			case ACTIONS.play: image = await renderPlay(key.settings); break;
			case ACTIONS.today: image = await renderToday(key.settings); break;
			default: return; // next and previous keep their manifest icons
		}
	} catch (error) {
		log("render failed", key.action, error);
		return;
	}
	if (!keys.has(context) || sent.get(context) === image) return;
	sent.set(context, image);
	emit({ event: "setImage", context, payload: { image, target: 0 } });
}

function redraw(filter = () => true) {
	for (const [context, key] of keys) if (filter(key)) draw(context);
}

// --------------------------------------------------------------------- Presses ---

async function press(context) {
	const key = keys.get(context);
	if (!key) return;
	let reply;
	switch (key.action) {
		case ACTIONS.playPause:
		case ACTIONS.nowPlaying:
			reply = await groovelight.send({ type: "playback", action: "toggle" });
			break;
		case ACTIONS.next:
			reply = await groovelight.send({ type: "playback", action: "next" });
			break;
		case ACTIONS.previous:
			reply = await groovelight.send({ type: "playback", action: "previous" });
			break;
		case ACTIONS.play: {
			const s = key.settings;
			const options = { shuffle: !!s.shuffle };
			if (s.kind === "album") Object.assign(options, { album: s.album, artist: s.artist || undefined });
			else if (s.kind === "artist") options.artist = s.artist;
			else if (s.kind === "search") options.query = s.query;
			else options.playlist = s.playlist;
			if (!options.album && !options.artist && !options.playlist && !options.query) return emit({ event: "showAlert", context });
			reply = await groovelight.send({ type: "play", options });
			break;
		}
		case ACTIONS.today: {
			const data = await loadToday();
			const pick = data?.picks.find((p) => p.kind === (key.settings.pick || "album"));
			if (!pick?.song_ids?.length) return emit({ event: "showAlert", context });
			reply = await groovelight.send({ type: "play", options: { songIds: pick.song_ids, shuffle: !!key.settings.shuffle } });
			break;
		}
	}
	if (reply?.error) {
		log("press failed:", reply.error);
		emit({ event: "showAlert", context });
		return;
	}
	// Playback replies carry now playing: show it at once instead of waiting for the next poll.
	if (reply?.data && typeof reply.data === "object" && "state" in reply.data) setPlaying(reply.data);
	else setTimeout(poll, 300);
}

// -------------------------------------------------------------------- OpenDeck ---

function emit(message) {
	if (socket?.readyState === 1) socket.send(JSON.stringify(message));
}

async function fromInspector(context, action, payload) {
	if (payload?.event === "getPlaylists") {
		const reply = (await groovelight.isRunning()) ? await groovelight.send({ type: "listPlaylists" }) : { error: "Groovelight is not running." };
		emit({
			event: "sendToPropertyInspector", context, action,
			payload: { event: "playlists", playlists: (reply.data?.playlists ?? []).map((p) => p.name), error: reply.error },
		});
	}
}

function connect(port, uuid, registerEvent) {
	socket = new WebSocket(`ws://127.0.0.1:${port}`);
	socket.onopen = () => {
		socket.send(JSON.stringify({ event: registerEvent, uuid }));
		log("connected to OpenDeck");
	};
	socket.onmessage = (message) => {
		let event;
		try {
			event = JSON.parse(message.data);
		} catch {
			return;
		}
		const { context, action } = event;
		const settings = event.payload?.settings ?? {};
		switch (event.event) {
			case "willAppear":
				keys.set(context, { action, settings });
				sent.delete(context);
				if (action === ACTIONS.playPause || action === ACTIONS.nowPlaying) poll().then(() => draw(context));
				else draw(context);
				break;
			case "willDisappear":
				keys.delete(context);
				sent.delete(context);
				break;
			case "didReceiveSettings":
				if (keys.has(context)) {
					keys.get(context).settings = settings;
					draw(context);
				}
				break;
			case "keyDown":
				press(context).catch((error) => log("press failed", error));
				break;
			case "sendToPlugin":
				fromInspector(context, action, event.payload).catch((error) => log("inspector failed", error));
				break;
			case "systemDidWakeUp":
				today = null;
				redraw();
				break;
		}
	};
	socket.onclose = () => {
		log("OpenDeck closed the connection");
		process.exit(0);
	};
	socket.onerror = (error) => log("websocket error", error.message ?? error);
}

function main() {
	const argv = process.argv.slice(2);
	const options = {};
	for (let i = 0; i + 1 < argv.length; i += 2) options[argv[i].replace(/^-+/, "")] = argv[i + 1];
	if (typeof WebSocket === "undefined") {
		log("Node.js 22 or later is needed (this is " + process.version + ").");
		process.exit(1);
	}
	connect(options.port, options.pluginUUID, options.registerEvent);

	let polling = false;
	setInterval(async () => {
		if (polling) return;
		polling = true;
		try {
			await poll();
		} catch (error) {
			log("poll failed", error);
		} finally {
			polling = false;
		}
	}, POLL_MS);
	// The day's picks change at midnight; covers of play keys may appear once the app runs.
	setInterval(() => {
		playCovers.forEach((uri, id) => uri || playCovers.delete(id));
		redraw((k) => k.action === ACTIONS.today || k.action === ACTIONS.play);
	}, 60 * 1000);
}

main();
