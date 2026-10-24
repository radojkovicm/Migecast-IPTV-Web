import { rename, writeFile } from "node:fs/promises";
import { parseCatalog } from "./catalog.mjs";

// Only this upstream repository is read. Failed refreshes preserve the checked-in snapshot.
const headers = { "User-Agent": "Migecast-IPTV-Web catalog importer" };
const revisionResponse = await fetch(
	"https://api.github.com/repos/Free-TV/IPTV/commits/master",
	{ headers, signal: AbortSignal.timeout(20000) },
);
if (!revisionResponse.ok) throw new Error("Cannot resolve upstream revision");
const { sha } = await revisionResponse.json();
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid upstream revision");
const response = await fetch(
	`https://raw.githubusercontent.com/Free-TV/IPTV/${sha}/playlist.m3u8`,
	{ signal: AbortSignal.timeout(30000) },
);
if (!response.ok) throw new Error("Cannot download public playlist");
const text = await response.text();
if (text.length > 5_000_000)
	throw new Error("Upstream playlist is unexpectedly large");
const channels = parseCatalog(text);
if (channels.length < 100 || channels.length > 20000)
	throw new Error("Unexpected catalog size; review upstream changes");
const snapshot = {
	source: "https://github.com/Free-TV/IPTV",
	revision: sha,
	updatedAt: new Date().toISOString(),
	channels,
};
await writeFile(
	"demo/channels.json.next",
	JSON.stringify(snapshot, null, "\t") + "\n",
);
await rename("demo/channels.json.next", "demo/channels.json");
console.log(
	JSON.stringify({
		channels: channels.length,
		countries: new Set(channels.map((c) => c.country)).size,
		browserCandidates: channels.filter((c) => ["hls", "video"].includes(c.kind))
			.length,
	}),
);
