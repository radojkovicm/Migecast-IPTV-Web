import { describe, expect, it, vi } from "vitest";

vi.mock("./provider-http", () => ({
	ProviderError: class extends Error {},
	providerText: vi.fn(),
	providerRecords: vi.fn(),
}));

import { loadMediaDetails, parseMediaDetails } from "./catalog-source";
import { providerText } from "./provider-http";

describe("safe lazy catalog details", () => {
	it("extracts allowlisted movie and series fields with a full plot", () => {
		const details = parseMediaDetails(
			{
				info: {
					plot: "A story. ".repeat(100),
					genre: "Drama",
					releasedate: "2023-04-12",
					duration: "01:42:30",
					rating: "8.2",
					cast: "Actor",
					director: "Director",
					stream_url: "https://private.invalid/secret",
				},
			},
			"Movie",
		);
		expect(details).toMatchObject({
			title: "Movie",
			genre: "Drama",
			year: "2023",
			durationSeconds: 6150,
			rating: "8.2",
			cast: "Actor",
			director: "Director",
		});
		expect(details.description?.length).toBeGreaterThan(300);
		expect(JSON.stringify(details)).not.toContain("private.invalid");
	});
	it("removes links, markup, controls and credential values from display fields", () => {
		const details = parseMediaDetails(
			{
				info: {
					plot: "<b>Story</b> https://provider.invalid/movie/user/secret/1.mp4\u0000 user secret",
					cast: ["unsafe"],
					genre: { url: "bad" },
				},
			},
			"Title",
			["user", "secret"],
		);
		expect(details.description).toBe("Story [redacted] [redacted]");
		expect(details.cast).toBeNull();
		expect(details.genre).toBeNull();
	});
	it("bounds lengths and rejects invalid numeric metadata", () => {
		expect(
			parseMediaDetails(
				{
					info: {
						plot: "x".repeat(20000),
						duration_secs: Infinity,
						duration: "01:99:01",
						rating: 11,
						year: "yesterday",
					},
				},
				"T",
			),
		).toMatchObject({
			description: "x".repeat(5000),
			durationSeconds: null,
			rating: null,
			year: null,
		});
		expect(
			parseMediaDetails({ info: { duration_secs: "3600" } }, "T")
				.durationSeconds,
		).toBe(3600);
	});
	it("provides explicit absent metadata for M3U and malformed fields", () => {
		expect(parseMediaDetails(null, "Title")).toEqual({
			title: "Title",
			description: null,
			genre: null,
			year: null,
			durationSeconds: null,
			rating: null,
			cast: null,
			director: null,
		});
	});
	it("requests only the appropriate provider action and numeric ID", async () => {
		vi.mocked(providerText).mockResolvedValue('{"info":{"plot":"Story"}}');
		const input = {
			kind: "xtream" as const,
			server: "https://example.invalid",
			username: "test-user",
			password: "test-pass",
		};
		await loadMediaDetails(input, "movie", "123", "Title");
		let requested = new URL(
			vi.mocked(providerText).mock.calls.at(-1)?.[0] ?? "",
		);
		expect(requested.searchParams.get("action")).toBe("get_vod_info");
		expect(requested.searchParams.get("vod_id")).toBe("123");
		await loadMediaDetails(input, "series", "456", "Title");
		requested = new URL(vi.mocked(providerText).mock.calls.at(-1)?.[0] ?? "");
		expect(requested.searchParams.get("series_id")).toBe("456");
		await expect(
			loadMediaDetails(input, "movie", "https://evil.invalid", "Title"),
		).rejects.toThrow();
	});
});
