import { readFile, writeFile } from "node:fs/promises";
import { safePublicUrl } from "./catalog.mjs";

export function exportPlaylist(channels) {
	const pinned = [
		"Serbia",
		"Croatia",
		"Bosnia and Herzegovina",
		"Slovenia",
		"Montenegro",
		"North Macedonia",
	];
	const rank = (country) =>
		pinned.includes(country) ? pinned.indexOf(country) : pinned.length;
	const clean = (value) =>
		String(value || "")
			.replace(/[\r\n"]/g, " ")
			.trim();
	const rows = channels
		.filter(
			(c) =>
				["hls", "video"].includes(c.kind) &&
				safePublicUrl(c.url)?.startsWith("https:"),
		)
		.sort(
			(a, b) =>
				rank(a.country) - rank(b.country) ||
				a.country.localeCompare(b.country) ||
				a.name.localeCompare(b.name),
		);
	return (
		"#EXTM3U\n" +
		rows
			.map(
				(c) =>
					`#EXTINF:-1 tvg-name="${clean(c.name)}" tvg-country="${clean(c.countryCode)}" group-title="${clean(c.country)}",${clean(c.name)}\n${c.url}`,
			)
			.join("\n") +
		"\n"
	);
}

export async function writePlaylist() {
	const snapshot = JSON.parse(await readFile("demo/channels.json", "utf8"));
	await writeFile("demo/dist/channels.m3u", exportPlaylist(snapshot.channels));
}
