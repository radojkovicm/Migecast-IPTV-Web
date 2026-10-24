import { createHash } from "node:crypto";
import type { PlaylistInput } from "@/lib/playlist-input";
import { ProviderError, providerRecords, providerText } from "./provider-http";
export type SourceItem = {
	sourceKey: string;
	kind: string;
	title: string;
	category: string;
	season?: number;
	episode?: number;
	parentKey?: string;
	locator: { url?: string; artwork?: string; seriesId?: string };
};
const text = (value: unknown, fallback = "") =>
	typeof value === "string" || typeof value === "number"
		? String(value).slice(0, 300)
		: fallback;
const id = (value: unknown) => {
	const result = text(value);
	if (!/^\d{1,15}$/.test(result)) throw new ProviderError("format");
	return result;
};
const extension = (value: unknown) =>
	/^[a-zA-Z0-9]{1,8}$/.test(String(value)) ? String(value) : "mp4";
export function xtreamUrl(
	input: Extract<PlaylistInput, { kind: "xtream" }>,
	action: string,
	extra: Record<string, string> = {},
) {
	const url = new URL(`${input.server}/player_api.php`);
	url.search = new URLSearchParams({
		username: input.username,
		password: input.password,
		action,
		...extra,
	}).toString();
	return url.href;
}
function streamUrl(
	input: Extract<PlaylistInput, { kind: "xtream" }>,
	kind: string,
	streamId: string,
	ext: string,
) {
	return `${input.server}/${kind}/${encodeURIComponent(input.username)}/${encodeURIComponent(input.password)}/${streamId}.${ext}`;
}
async function json(url: string): Promise<unknown> {
	try {
		return JSON.parse(await providerText(url));
	} catch (error) {
		if (error instanceof ProviderError) throw error;
		throw new ProviderError("format");
	}
}
function records(value: unknown): Record<string, unknown>[] {
	if (
		!Array.isArray(value) ||
		value.length > 50000 ||
		value.some((v) => !v || typeof v !== "object" || Array.isArray(v))
	)
		throw new ProviderError("format");
	return value;
}
export function parseM3u(content: string): SourceItem[] {
	if (!/^\uFEFF?#EXTM3U(?:\s|$)/.test(content))
		throw new ProviderError("format");
	const result: SourceItem[] = [];
	const series = new Map<string, SourceItem>();
	let metadata = "";
	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith("#EXTINF:")) {
			metadata = line;
			continue;
		}
		if (line.startsWith("#")) continue;
		if (!metadata) throw new ProviderError("format");
		const url = new URL(line);
		if (!["http:", "https:"].includes(url.protocol))
			throw new ProviderError("format");
		const attributes = Object.fromEntries(
			[...metadata.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
		);
		// Commas in quoted attributes are not the title separator.
		const label = metadata.replace(/"[^"]*"/g, '""');
		const title =
			text(
				metadata.slice(
					label.indexOf(",") < 0
						? metadata.length
						: (() => {
								let quote = false;
								for (let i = 0; i < metadata.length; i++) {
									if (metadata[i] === '"') quote = !quote;
									if (metadata[i] === "," && !quote) return i + 1;
								}
								return metadata.length;
							})(),
				),
				"Bez naziva",
			).trim() || "Bez naziva";
		const category = text(attributes["group-title"], "Ostalo");
		const key = createHash("sha256").update(url.href).digest("hex");
		const match = title.match(/^(.*?)\s+[Ss](\d{1,2})[ ._-]*[Ee](\d{1,3})\b/);
		let kind =
			/\/movie\//i.test(url.pathname) ||
			/\.(mp4|mkv|webm|avi)$/i.test(url.pathname) ||
			/movie|film|vod/i.test(category)
				? "movie"
				: "tv";
		let parentKey: string | undefined;
		if (match) {
			kind = "episode";
			parentKey = `series:${createHash("sha256").update(`${category}:${match[1]}`).digest("hex")}`;
			let parent = series.get(parentKey);
			if (!parent) {
				parent = {
					sourceKey: parentKey,
					kind: "series",
					title: match[1],
					category,
					locator: {},
				};
				series.set(parentKey, parent);
				result.push(parent);
			}
			// M3U has no separate series record; retain the first supplied poster.
			if (!parent.locator.artwork && attributes["tvg-logo"]?.trim())
				parent.locator.artwork = attributes["tvg-logo"].trim();
		}
		result.push({
			sourceKey: key,
			kind,
			title,
			category,
			parentKey,
			season: match ? Number(match[2]) : undefined,
			episode: match ? Number(match[3]) : undefined,
			locator: { url: url.href, artwork: attributes["tvg-logo"] },
		});
		metadata = "";
		if (result.length > 50000) throw new ProviderError("size");
	}
	if (!result.length || metadata) throw new ProviderError("format");
	return [...new Map(result.map((item) => [item.sourceKey, item])).values()];
}
export async function loadCatalog(input: PlaylistInput): Promise<SourceItem[]> {
	if (input.kind !== "xtream")
		return parseM3u(
			input.kind === "file"
				? input.content
				: await providerText(input.url, 10 * 1024 * 1024),
		);
	const output: SourceItem[] = [];
	// Sequential API calls avoid saturating provider connection limits.
	for (const [kind, action, categoryAction, path] of [
		["tv", "get_live_streams", "get_live_categories", "live"],
		["movie", "get_vod_streams", "get_vod_categories", "movie"],
		["series", "get_series", "get_series_categories", "series"],
	]) {
		const categories = records(await json(xtreamUrl(input, categoryAction)));
		const names = new Map(
			categories.map((row) => [text(row.category_id), text(row.category_name)]),
		);
		for await (const value of providerRecords(xtreamUrl(input, action))) {
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new ProviderError("format");
			const row = value as Record<string, unknown>;
			if (output.length >= 500000) throw new ProviderError("size");
			const streamId = id(kind === "series" ? row.series_id : row.stream_id);
			output.push({
				sourceKey: `${kind}:${streamId}`,
				kind,
				title: text(row.name, "Bez naziva"),
				category: names.get(text(row.category_id)) ?? "Ostalo",
				locator:
					kind === "series"
						? { seriesId: streamId, artwork: text(row.cover) }
						: {
								url: streamUrl(
									input,
									path,
									streamId,
									kind === "tv" ? "m3u8" : extension(row.container_extension),
								),
								artwork: text(row.stream_icon),
							},
			});
		}
	}
	if (!output.length) throw new ProviderError("format");
	return output;
}
export async function loadEpisodes(
	input: Extract<PlaylistInput, { kind: "xtream" }>,
	seriesId: string,
	parentKey: string,
): Promise<SourceItem[]> {
	const response = await json(
		xtreamUrl(input, "get_series_info", { series_id: id(seriesId) }),
	);
	if (
		!response ||
		typeof response !== "object" ||
		!("episodes" in response) ||
		!response.episodes ||
		typeof response.episodes !== "object"
	)
		throw new ProviderError("format");
	return Object.entries(response.episodes).flatMap(([season, items]) =>
		records(items).map((row) => ({
			sourceKey: `episode:${id(row.id)}`,
			kind: "episode",
			title: text(row.title, `Epizoda ${text(row.episode_num)}`),
			category: "",
			parentKey,
			season: Math.max(0, Number(row.season ?? season) || 0),
			episode: Math.max(0, Number(row.episode_num) || 0),
			locator: {
				url: streamUrl(
					input,
					"series",
					id(row.id),
					extension(row.container_extension),
				),
			},
		})),
	);
}

export type MediaDetails = {
	title: string;
	description: string | null;
	genre: string | null;
	year: string | null;
	durationSeconds: number | null;
	rating: string | null;
	cast: string | null;
	director: string | null;
};

/** Only display fields may leave the provider boundary. Never spread provider records. */
export function parseMediaDetails(
	value: unknown,
	title: string,
	secrets: string[] = [],
): MediaDetails {
	const object = (v: unknown): Record<string, unknown> =>
		v && typeof v === "object" && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: {};
	const root = object(value);
	const info = object(root.info);
	const safeText = (v: unknown, limit = 300): string | null => {
		if (typeof v !== "string" && typeof v !== "number") return null;
		let result = String(v)
			.slice(0, 16000)
			.replace(/<[^>]*>/g, " ")
			.replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, "")
			.replace(/\p{Cc}/gu, " ");
		for (const secret of secrets) {
			if (secret) result = result.split(secret).join("[redacted]");
		}
		result = result.replace(/\s+/g, " ").trim().slice(0, limit);
		return result || null;
	};
	const seconds = Number(info.duration_secs);
	const clock =
		typeof info.duration === "string"
			? info.duration.match(/^(\d{1,3}):(\d{2}):(\d{2})$/)
			: null;
	const clockSeconds =
		clock && Number(clock[2]) < 60 && Number(clock[3]) < 60
			? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
			: 0;
	const duration =
		Number.isFinite(seconds) && seconds > 0 ? seconds : clockSeconds;
	const release = safeText(info.releasedate ?? info.releaseDate ?? info.year);
	const ratingValue = Number(info.rating);
	return {
		title,
		description: safeText(info.plot ?? info.description, 5000),
		genre: safeText(info.genre),
		year: release?.match(/\b(?:19|20)\d{2}\b/)?.[0] ?? null,
		durationSeconds:
			duration > 0 && duration <= 7 * 24 * 3600 ? Math.round(duration) : null,
		rating:
			Number.isFinite(ratingValue) && ratingValue > 0 && ratingValue <= 10
				? String(ratingValue)
				: null,
		cast: safeText(info.cast ?? info.actors, 1000),
		director: safeText(info.director),
	};
}

export async function loadMediaDetails(
	input: Extract<PlaylistInput, { kind: "xtream" }>,
	kind: "movie" | "series",
	sourceId: string,
	title: string,
): Promise<MediaDetails> {
	const response = await json(
		xtreamUrl(
			input,
			kind === "movie" ? "get_vod_info" : "get_series_info",
			kind === "movie" ? { vod_id: id(sourceId) } : { series_id: id(sourceId) },
		),
	);
	if (!response || typeof response !== "object" || Array.isArray(response))
		throw new ProviderError("format");
	return parseMediaDetails(response, title, [input.username, input.password]);
}
