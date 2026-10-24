const $ = (id) => document.getElementById(id);
const video = $("video");
const player = $("player");
const status = $("status");
let channels = [],
	selected = null,
	hls = null,
	favoritesOnly = false,
	timeout,
	active = false;
let favorites = new Set();
try {
	const stored = JSON.parse(
		localStorage.getItem("migecast-demo-favorites") || "[]",
	);
	if (Array.isArray(stored))
		favorites = new Set(stored.filter((x) => typeof x === "string"));
} catch {}
function save() {
	try {
		localStorage.setItem(
			"migecast-demo-favorites",
			JSON.stringify([...favorites]),
		);
	} catch {}
}
function render() {
	$("channels").replaceChildren();
	const visible = channels.filter(
		(c) =>
			(!favoritesOnly || favorites.has(c.id)) &&
			c.name.toLowerCase().includes($("search").value.toLowerCase()),
	);
	for (const channel of visible) {
		const row = document.createElement("div");
		row.className = `channel${selected?.id === channel.id ? " active" : ""}`;
		const button = document.createElement("button");
		button.className = "select";
		button.textContent = channel.name;
		button.setAttribute("aria-pressed", String(selected?.id === channel.id));
		button.onclick = () => play(channel);
		button.ondblclick = () => expand();
		const star = document.createElement("button");
		star.className = "favorite";
		star.textContent = "★";
		star.setAttribute("aria-label", `Omiljeno: ${channel.name}`);
		star.setAttribute("aria-pressed", String(favorites.has(channel.id)));
		star.onclick = () => {
			favorites.has(channel.id)
				? favorites.delete(channel.id)
				: favorites.add(channel.id);
			save();
			render();
		};
		row.append(button, star);
		$("channels").append(row);
	}
	if (!visible.length) {
		const message = document.createElement("p");
		message.className = "empty";
		message.textContent = favoritesOnly
			? "Označite kanale zvezdicom u listi Svi kanali."
			: "Nema pronađenih kanala.";
		$("channels").append(message);
	}
}
function stop() {
	active = false;
	clearTimeout(timeout);
	if (hls) {
		hls.destroy();
		hls = null;
	}
	video.pause();
	video.removeAttribute("src");
	video.load();
}
function fail() {
	stop();
	status.textContent =
		"Kanal trenutno nije dostupan. Pokušajte ponovo ili izaberite drugi kanal.";
}
function attemptPlay() {
	video.play().catch(() => {
		if (!active) return;
		status.textContent = "Pritisnite ▶ u plejeru da pokrenete kanal.";
	});
}
function play(channel) {
	stop();
	active = true;
	selected = channel;
	$("now").textContent = channel.name;
	$("placeholder").hidden = true;
	status.textContent = "Povezivanje…";
	render();
	timeout = setTimeout(fail, 25000);
	if (video.canPlayType("application/vnd.apple.mpegurl")) {
		video.src = channel.url;
		attemptPlay();
	} else if (globalThis.Hls?.isSupported()) {
		hls = new Hls({
			maxBufferLength: 20,
			maxMaxBufferLength: 30,
			backBufferLength: 10,
		});
		hls.on(Hls.Events.ERROR, (_, data) => {
			if (data.fatal) fail();
		});
		hls.on(Hls.Events.MANIFEST_PARSED, attemptPlay);
		hls.loadSource(channel.url);
		hls.attachMedia(video);
	} else {
		clearTimeout(timeout);
		status.textContent =
			"Ovaj browser ne podržava HLS video. Probajte noviji browser.";
	}
}
video.addEventListener("playing", () => {
	clearTimeout(timeout);
	status.textContent = "Uživo";
});
video.addEventListener("waiting", () => {
	if (active) status.textContent = "Učitavanje…";
});
video.addEventListener("error", () => {
	if (selected && video.getAttribute("src")) fail();
});
video.addEventListener("dblclick", () => {
	if (document.fullscreenElement || player.classList.contains("expanded"))
		shrink();
	else expand();
});
async function expand() {
	if (
		document.fullscreenElement === player ||
		player.classList.contains("expanded")
	)
		return shrink();
	try {
		await player.requestFullscreen();
		try {
			await screen.orientation.lock("landscape");
		} catch {}
	} catch {
		player.classList.add("expanded");
	}
}
async function shrink() {
	player.classList.remove("expanded");
	try {
		screen.orientation.unlock();
	} catch {}
	if (document.fullscreenElement)
		await document.exitFullscreen().catch(() => {});
}
$("fullscreen").onclick = expand;
$("exit-fullscreen").onclick = shrink;
$("app-fullscreen").onclick = async () => {
	if (document.fullscreenElement) return shrink();
	try {
		await document.documentElement.requestFullscreen();
	} catch {
		status.textContent =
			"Browser ne dozvoljava ceo ekran; koristite dugme za povećanje plejera.";
	}
};
document.addEventListener("fullscreenchange", () => {
	const label = document.fullscreenElement ? "Smanji ekran" : "Ceo ekran";
	$("app-fullscreen").setAttribute("aria-label", label);
	$("app-fullscreen").title = label;
});
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") shrink();
});
$("retry").onclick = () => {
	if (selected) play(selected);
};
$("fit").onclick = () => {
	const cover = player.classList.toggle("cover");
	$("fit").setAttribute("aria-pressed", String(cover));
	$("fit").title = cover ? "Cela slika" : "Popuni ekran";
	$("fit").setAttribute("aria-label", $("fit").title);
};
$("search").oninput = render;
for (const [id, value] of [
	["all", false],
	["favorites", true],
])
	$(id).onclick = () => {
		favoritesOnly = value;
		$("all").setAttribute("aria-pressed", String(!value));
		$("favorites").setAttribute("aria-pressed", String(value));
		render();
	};
window.addEventListener("pagehide", stop);
try {
	const response = await fetch("channels.json");
	if (!response.ok) throw new Error();
	channels = await response.json();
	render();
} catch {
	status.textContent = "Lista kanala nije učitana. Osvežite stranicu.";
}
