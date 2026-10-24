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
let filtered = [],
	rendered = 0,
	observer;
const countryLabel = (channel) => {
	try {
		return channel.countryCode
			? new Intl.DisplayNames(["sr-Latn"], { type: "region" }).of(
					channel.countryCode,
				)
			: channel.country;
	} catch {
		return channel.country;
	}
};
function render() {
	$("channels").replaceChildren();
	filtered = channels.filter(
		(c) =>
			(!favoritesOnly || favorites.has(c.id)) &&
			(!$("country").value || c.country === $("country").value) &&
			(!$("playable").checked || ["hls", "video"].includes(c.kind)) &&
			c.name.toLowerCase().includes($("search").value.toLowerCase()),
	);
	rendered = 0;
	observer?.disconnect();
	$("count").textContent = `${filtered.length} kanala`;
	$("channels").scrollTop = 0;
	appendChannels();
	if (!filtered.length) {
		const message = document.createElement("p");
		message.className = "empty";
		message.textContent = favoritesOnly
			? "Nema omiljenih kanala za izabrane filtere. Označite kanale zvezdicom."
			: "Nema kanala za izabrane filtere.";
		$("channels").append(message);
	}
}
function appendChannels() {
	$("more-channels")?.remove();
	for (const channel of filtered.slice(rendered, rendered + 80)) {
		const row = document.createElement("div");
		row.className = `channel${selected?.id === channel.id ? " active" : ""}`;
		const button = document.createElement("button");
		button.className = "select";
		button.dataset.channelId = channel.id;
		const title = document.createElement("span");
		title.textContent = channel.name;
		const detail = document.createElement("small");
		detail.textContent = `${countryLabel(channel)} · ${channel.kind === "hls" || channel.kind === "video" ? "TV" : channel.kind === "website" ? "Web izvor" : "Drugi plejer"}`;
		button.append(title, detail);
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
	rendered += 80;
	if (rendered < filtered.length) {
		const sentinel = document.createElement("div");
		sentinel.id = "more-channels";
		sentinel.textContent = "Učitavanje kanala…";
		$("channels").append(sentinel);
		observer?.disconnect();
		observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) appendChannels();
			},
			{ root: $("channels"), rootMargin: "160px" },
		);
		observer.observe(sentinel);
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
		"Kanal trenutno nije dostupan u ovom browseru ili na vašoj lokaciji. Pokušajte drugi kanal ili otvorite izvor.";
	$("source-link").hidden = false;
}
function attemptPlay() {
	video.play().catch(() => {
		if (!active) return;
		status.textContent = "Pritisnite ▶ u plejeru da pokrenete kanal.";
	});
}
function markSelection() {
	for (const button of document.querySelectorAll(".select")) {
		const chosen = button.dataset.channelId === selected?.id;
		button.setAttribute("aria-pressed", String(chosen));
		button.parentElement.classList.toggle("active", chosen);
	}
}
function play(channel) {
	stop();
	$("source-link").href = channel.url.startsWith("https:")
		? channel.url
		: "https://github.com/Free-TV/IPTV/tree/master/lists";
	$("source-link").hidden = true;
	if (!["hls", "video"].includes(channel.kind)) {
		selected = channel;
		$("now").textContent = channel.name;
		$("placeholder").hidden = false;
		status.textContent =
			channel.kind === "website"
				? "Ovaj izvor se gleda na njegovom sajtu. Otvorite izvor ispod plejera."
				: "Ovaj kanal nema direktan HTTPS video za browser. Pogledajte izvorni katalog.";
		$("source-link").hidden = false;
		markSelection();
		return;
	}
	active = true;
	selected = channel;
	$("now").textContent = channel.name;
	$("placeholder").hidden = true;
	status.textContent = "Povezivanje…";
	markSelection();
	timeout = setTimeout(fail, 25000);
	if (
		channel.kind === "video" ||
		video.canPlayType("application/vnd.apple.mpegurl")
	) {
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
$("country").onchange = render;
$("playable").onchange = render;
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
	const snapshot = await response.json();
	channels = snapshot.channels;
	if (!Array.isArray(channels)) throw new Error("Invalid catalog");
	const countries = new Map(channels.map((c) => [c.country, countryLabel(c)]));
	for (const [country, label] of [...countries].sort((a, b) =>
		a[1].localeCompare(b[1], "sr-Latn"),
	)) {
		const option = document.createElement("option");
		option.value = country;
		option.textContent = label;
		$("country").append(option);
	}
	$("status").textContent =
		`${channels.length} kanala iz ${countries.size} država i grupa. Izaberite državu ili pronađite kanal.`;
	render();
} catch {
	status.textContent = "Lista kanala nije učitana. Osvežite stranicu.";
}
