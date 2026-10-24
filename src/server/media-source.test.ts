import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseM3u } from "./catalog-source";
import { inspectMedia, publicAddress } from "./provider-http";

describe("Provider boundaries", () => {
	it("rejects private, mapped, reserved, link-local and multicast addresses", () => {
		for (const address of [
			"127.0.0.1",
			"10.1.2.3",
			"192.168.2.1",
			"172.20.1.1",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"224.0.0.1",
			"::1",
			"::",
			"fc00::1",
			"fe80::1",
			"::ffff:127.0.0.1",
			"192.0.2.1",
		])
			expect(publicAddress(address), address).toBe(false);
		expect(publicAddress("8.8.8.8")).toBe(true);
		expect(publicAddress("2606:4700:4700::1111")).toBe(true);
	});
	it("classifies TV, films and grouped series without leaking URLs into titles", () => {
		const rows = parseM3u(
			'#EXTM3U\n#EXTINF:-1 group-title="TV, news",News\nhttps://media.example/live/u/p/1.m3u8\n#EXTINF:-1 group-title="Films",Film\nhttps://media.example/movie/u/p/2.mp4\n#EXTINF:-1 group-title="Shows",Example S01E02\nhttps://media.example/series/u/p/3.mp4',
		);
		expect(rows.map((r) => r.kind)).toEqual([
			"tv",
			"movie",
			"series",
			"episode",
		]);
		expect(rows[0].title).toBe("News");
		expect(rows[3].parentKey).toBe(rows[2].sourceKey);
		expect(rows[3].episode).toBe(2);
	});
	it("keeps the first available M3U series poster without mixing series", () => {
		const rows = parseM3u(
			[
				"#EXTM3U",
				'#EXTINF:-1 group-title="Shows",Example S01E01',
				"https://media.example/series/1.mp4",
				'#EXTINF:-1 group-title="Shows" tvg-logo="https://images.example/example.jpg",Example S01E02',
				"https://media.example/series/2.mp4",
				'#EXTINF:-1 group-title="Shows" tvg-logo="https://images.example/later.jpg",Example S01E03',
				"https://media.example/series/3.mp4",
				'#EXTINF:-1 group-title="Shows" tvg-logo="https://images.example/other.jpg",Other S01E01',
				"https://media.example/series/4.mp4",
			].join("\n"),
		);
		const shows = rows.filter((row) => row.kind === "series");
		expect(shows).toHaveLength(2);
		expect(shows[0].locator).toEqual({
			artwork: "https://images.example/example.jpg",
		});
		expect(shows[1].locator).toEqual({
			artwork: "https://images.example/other.jpg",
		});
		expect(rows.filter((row) => row.kind === "episode")).toHaveLength(4);
	});
	it("rejects incomplete or non-playlist provider data", () => {
		for (const value of [
			"<html>Error</html>",
			"#EXTM3U\n#EXTINF:-1,Missing",
			"#EXTM3U\nhttps://example.org/movie.mp4",
		])
			expect(() => parseM3u(value)).toThrow();
	});
});

describe("Media signature routing", () => {
	async function inspect(bytes: Buffer, type = "application/octet-stream") {
		const stream = Readable.from([bytes]) as unknown as IncomingMessage;
		stream.headers = { "content-type": type };
		return inspectMedia(stream);
	}
	it("separates WebM and Matroska despite misleading HTTP headers", async () => {
		const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
		expect(
			(
				await inspect(
					Buffer.concat([ebml, Buffer.from("matroska")]),
					"video/webm",
				)
			).kind,
		).toBe("worker");
		expect(
			(await inspect(Buffer.concat([ebml, Buffer.from("webm")]))).kind,
		).toBe("direct");
	});
	it("recognizes TS packets, while refusing arbitrary binary data", async () => {
		const ts = Buffer.alloc(1024);
		ts[0] = ts[188] = ts[376] = 0x47;
		expect((await inspect(ts)).container).toBe("mpegts");
		expect((await inspect(Buffer.alloc(1024))).kind).toBe("binary");
	});
});
