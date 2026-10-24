import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCatalog, safePublicUrl } from "./catalog.mjs";

test("preserves countries and deduplicates exact entries", () => {
	const row =
		'#EXTINF:-1 tvg-name="A" tvg-country="RS" group-title="Serbia",A\nhttps://stream.example.com/a.m3u8';
	const result = parseCatalog(
		"#EXTM3U\n" +
			row +
			"\n" +
			row +
			'\n#EXTINF:-1 group-title="Germany",B\nhttps://example.com/watch',
	);
	assert.equal(result.length, 2);
	assert.equal(result[0].countryCode, "RS");
	assert.equal(result[0].kind, "hls");
	assert.equal(result[1].kind, "website");
	assert.equal(result[1].name, "B");
	assert.equal(parseCatalog("#EXTM3U\n" + row)[0].id, result[0].id);
});
test("retains unsupported entries without executing unsafe URLs", () => {
	const rows = [
		"javascript:alert(1)",
		"rtmp://example.com/a",
		"[NO PUBLIC STREAM]",
		"http://example.com/a.m3u8",
	];
	const result = parseCatalog(
		"#EXTM3U\n" +
			rows
				.map((u, i) => `#EXTINF:-1 group-title="Test",Channel ${i}\n${u}`)
				.join("\n"),
	);
	assert.equal(result.length, 4);
	assert.ok(result.every((c) => c.kind === "unsupported"));
	assert.equal(result[0].url, "");
});
test("rejects credentials, signed links and local network destinations", () => {
	for (const u of [
		"https://user:pass@example.com/a",
		"https://example.com/a?token=abc",
		"http://127.0.0.1/a",
		"https://10.0.0.1/a",
		"https://[::1]/a",
		"https://server.local/a",
		"file:///etc/passwd",
	])
		assert.equal(safePublicUrl(u), null);
	assert.equal(
		safePublicUrl("https://example.com/live.m3u8"),
		"https://example.com/live.m3u8",
	);
});
test("refuses HTML pretending to be a playlist", () =>
	assert.throws(() => parseCatalog("<html>Error</html>")));

test("M3U export preserves all browser sources and country categories", async () => {
	const { exportPlaylist } = await import("./export-playlist.mjs");
	const { readFile } = await import("node:fs/promises");
	const { channels } = JSON.parse(await readFile("demo/channels.json", "utf8"));
	const result = parseCatalog(exportPlaylist(channels));
	assert.equal(result.length, channels.length);
	assert.deepEqual(
		new Set(result.map((c) => c.url)),
		new Set(channels.map((c) => c.url)),
	);
	assert.deepEqual([...new Set(result.map((c) => c.country))].slice(0, 6), [
		"Serbia",
		"Croatia",
		"Bosnia and Herzegovina",
		"Slovenia",
		"Montenegro",
		"North Macedonia",
	]);
});
