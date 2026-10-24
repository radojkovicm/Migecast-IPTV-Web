import { z } from "zod";

export const MAX_PLAYLIST_BYTES = 10 * 1024 * 1024;
const webUrl = z
	.string()
	.trim()
	.min(1)
	.max(8192)
	.refine((value) => {
		try {
			const url = new URL(value);
			return (
				["http:", "https:"].includes(url.protocol) &&
				!url.username &&
				!url.password &&
				!!url.hostname
			);
		} catch {
			return false;
		}
	}, "Neispravna HTTP(S) adresa.");

export const playlistInput = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("url"), url: webUrl }).strict(),
	z
		.object({
			kind: z.literal("xtream"),
			server: webUrl,
			username: z.string().trim().min(1).max(256),
			password: z.string().min(1).max(1024),
		})
		.strict(),
	z
		.object({
			kind: z.literal("file"),
			content: z.string().min(1).max(MAX_PLAYLIST_BYTES),
		})
		.strict(),
]);
export const createPlaylistInput = z
	.object({ name: z.string().trim().min(1).max(100), input: playlistInput })
	.strict();
export const updatePlaylistInput = z
	.object({
		name: z.string().trim().min(1).max(100),
		input: playlistInput.optional(),
		revision: z.number().int().positive(),
	})
	.strict();
export const deletePlaylistInput = z
	.object({
		revision: z.number().int().positive(),
		detach: z.boolean().default(false),
	})
	.strict();
export const assignmentInput = z
	.object({
		playlistIds: z.array(z.string().min(1).max(100)).max(100),
		revision: z.number().int().nonnegative(),
		deactivate: z.boolean().default(false),
	})
	.strict()
	.refine(
		(value) => new Set(value.playlistIds).size === value.playlistIds.length,
	);
export const selectionInput = z
	.object({
		playlistId: z.string().min(1).max(100).nullable(),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type PlaylistInput = z.infer<typeof playlistInput>;
export type NormalizedPlaylist = {
	input: PlaylistInput;
	kind: "m3u" | "xtream" | "file";
	entryCount: number | null;
	identity: string;
};

function normalizeXtream(
	server: string,
	username: string,
	password: string,
): NormalizedPlaylist {
	const url = new URL(server);
	if (
		url.search ||
		url.hash ||
		/\/(get|player_api)\.php\/?$/i.test(url.pathname)
	)
		throw new Error(
			"Unesite adresu Xtream servera, bez API putanje i parametara.",
		);
	const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
	return {
		input: { kind: "xtream", server: base, username, password },
		kind: "xtream",
		entryCount: null,
		identity: `xtream:${base}\n${username}`,
	};
}

/** Parse source metadata only. Never fetch URLs or treat a saved source as working. */
export function normalizePlaylist(input: PlaylistInput): NormalizedPlaylist {
	if (input.kind === "xtream")
		return normalizeXtream(input.server, input.username, input.password);
	if (input.kind === "url") {
		const url = new URL(input.url);
		url.hash = "";
		if (/\/get\.php$/i.test(url.pathname)) {
			const username = url.searchParams.get("username");
			const password = url.searchParams.get("password");
			if (
				!username ||
				!password ||
				username.length > 256 ||
				password.length > 1024
			)
				throw new Error("Xtream link mora sadržati korisničko ime i lozinku.");
			return normalizeXtream(
				`${url.origin}${url.pathname.slice(0, -8)}`,
				username,
				password,
			);
		}
		url.searchParams.sort();
		return {
			input: { kind: "url", url: url.href },
			kind: "m3u",
			entryCount: null,
			identity: `m3u:${url.href}`,
		};
	}
	if (new TextEncoder().encode(input.content).byteLength > MAX_PLAYLIST_BYTES)
		throw new Error("Lista može imati najviše 10 MiB.");
	const content = input.content
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.trim();
	const lines = content.split("\n");
	if (
		!/^#EXTM3U(?:\s|$)/.test(lines[0]) ||
		content.includes("\0") ||
		/^#EXT-X-/m.test(content)
	)
		throw new Error("Izaberite M3U listu kanala, filmova ili serija.");
	let count = 0;
	let pending = false;
	for (const value of lines.slice(1)) {
		const line = value.trim();
		if (!line) continue;
		if (line.startsWith("#EXTINF:")) {
			pending = true;
			continue;
		}
		if (line.startsWith("#")) continue;
		if (!pending || !webUrl.safeParse(line).success)
			throw new Error(
				"Lista sadrži neispravnu stavku. Podržane su HTTP(S) adrese.",
			);
		count++;
		pending = false;
	}
	if (!count || pending) throw new Error("Lista je prazna ili nepotpuna.");
	return {
		input: { kind: "file", content },
		kind: "file",
		entryCount: count,
		identity: `file:${content}`,
	};
}
