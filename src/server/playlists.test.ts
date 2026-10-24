import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createPlaylistInput,
	MAX_PLAYLIST_BYTES,
	normalizePlaylist,
	playlistInput,
} from "../lib/playlist-input";
import {
	decryptPlaylist,
	encryptPlaylist,
	playlistIdentity,
	playlistKey,
} from "./playlist-crypto";

describe("playlist input modes", () => {
	it("recognizes full Xtream links and shares account identity with the explicit form", () => {
		const link = normalizePlaylist({
			kind: "url",
			url: "https://example.invalid/provider/get.php?username=test&password=p%2Bss&type=m3u_plus&output=ts",
		});
		const form = normalizePlaylist({
			kind: "xtream",
			server: "https://example.invalid/provider/",
			username: "test",
			password: "new-password",
		});
		expect(link.input).toEqual({
			kind: "xtream",
			server: "https://example.invalid/provider",
			username: "test",
			password: "p+ss",
		});
		expect(link.identity).toBe(form.identity);
	});
	it("accepts BOM and CRLF uploaded playlists without executing their content", () => {
		const input = {
			kind: "file" as const,
			content:
				'\uFEFF#EXTM3U\r\n#EXTINF:-1 group-title="Filmovi",Test\r\nhttps://example.invalid/movie.mp4\r\n',
		};
		const result = normalizePlaylist(input);
		expect(result.entryCount).toBe(1);
		expect(result.input.kind).toBe("file");
	});
	it("rejects empty, partial, non-http, HLS manifests and oversized uploads", () => {
		for (const content of [
			"",
			"not M3U",
			"#EXTM3U\n",
			"#EXTM3U\n#EXTINF:-1,Test",
			"#EXTM3U\n#EXTINF:-1,Test\nfile:///etc/passwd",
			"#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nhttps://example.invalid/a.ts",
			`#EXTM3U\n#${"č".repeat(MAX_PLAYLIST_BYTES / 2)}`,
		]) {
			expect(() => normalizePlaylist({ kind: "file", content })).toThrow();
		}
	});
	it("rejects missing Xtream credentials and executable URLs without reflecting them", () => {
		expect(() =>
			normalizePlaylist({
				kind: "url",
				url: "https://example.invalid/get.php?username=secret",
			}),
		).toThrow("Xtream link");
		expect(
			playlistInput.safeParse({ kind: "url", url: "javascript:alert(1)" })
				.success,
		).toBe(false);
		expect(
			playlistInput.safeParse({
				kind: "url",
				url: "https://user:secret@example.invalid/",
			}).success,
		).toBe(false);
		expect(
			createPlaylistInput.safeParse({
				name: " ",
				input: {
					kind: "xtream",
					server: "https://example.invalid",
					username: "u",
					password: "p",
				},
			}).success,
		).toBe(false);
	});
});

describe("source encryption", () => {
	it("encrypts the full source with unique nonces and authenticated source binding", () => {
		const key = randomBytes(32);
		const value = {
			kind: "xtream",
			server: "https://example.invalid",
			username: "test-account",
			password: "private-test-value",
		};
		const first = encryptPlaylist("one", value, key);
		expect(first).not.toContain(value.password);
		expect(first).not.toBe(encryptPlaylist("one", value, key));
		expect(decryptPlaylist("one", first, key)).toEqual(value);
		expect(() => decryptPlaylist("two", first, key)).toThrow(
			"could not be decrypted",
		);
		expect(() => decryptPlaylist("one", first, randomBytes(32))).toThrow(
			"could not be decrypted",
		);
		const pieces = first.split(".");
		pieces[3] = `A${pieces[3].slice(1)}`;
		if (pieces.join(".") === first) pieces[3] = `B${pieces[3].slice(1)}`;
		expect(() => decryptPlaylist("one", pieces.join("."), key)).toThrow(
			"could not be decrypted",
		);
		expect(playlistIdentity("account", key)).toBe(
			playlistIdentity("account", key),
		);
		expect(playlistIdentity("account", key)).not.toBe(
			playlistIdentity("account", randomBytes(32)),
		);
	});
	it("fails closed on invalid source encryption configuration", () => {
		for (const key of ["", "x".repeat(64), "a".repeat(63)])
			expect(() => playlistKey(key)).toThrow("Configure");
	});
});
