// Shared by the settings pages: connects to OpenDeck, loads the key's settings into the form and saves every change.
let socket, uuid, action, settings = {};
const handlers = [];

function connectElgatoStreamDeckSocket(port, inUUID, registerEvent, info, actionInfo) {
	uuid = inUUID;
	const parsed = JSON.parse(actionInfo);
	action = parsed.action;
	settings = (parsed.payload || {}).settings || {};
	socket = new WebSocket("ws://127.0.0.1:" + port);
	socket.onopen = () => {
		socket.send(JSON.stringify({ event: registerEvent, uuid }));
		load();
	};
	socket.onmessage = (message) => {
		const data = JSON.parse(message.data);
		if (data.event === "sendToPropertyInspector") handlers.forEach((handler) => handler(data.payload || {}));
	};
}

function toPlugin(payload) {
	socket.send(JSON.stringify({ event: "sendToPlugin", context: uuid, action, payload }));
}

function save() {
	socket.send(JSON.stringify({ event: "setSettings", context: uuid, payload: settings }));
}

/** Fills each [data-setting] field from the settings, and saves it when it changes. */
function load() {
	document.querySelectorAll("[data-setting]").forEach((field) => {
		const name = field.dataset.setting;
		const value = settings[name];
		if (field.type === "checkbox") field.checked = value === undefined ? field.defaultChecked : !!value;
		else if (value !== undefined) field.value = value;
		const update = () => {
			settings[name] = field.type === "checkbox" ? field.checked : field.value.trim();
			save();
			document.dispatchEvent(new Event("settingschange"));
		};
		field.addEventListener(field.tagName === "SELECT" || field.type === "checkbox" ? "change" : "change", update);
	});
	document.dispatchEvent(new Event("settingsload"));
}
