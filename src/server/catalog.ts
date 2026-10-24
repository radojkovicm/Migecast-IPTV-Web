import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { playlistInput } from "@/lib/playlist-input";
import { visibleCategories } from "../lib/category-visibility";
import {
	loadCatalog,
	loadEpisodes,
	loadMediaDetails,
	type MediaDetails,
	parseMediaDetails,
	type SourceItem,
} from "./catalog-source";
import { getDb } from "./db";
import { HttpError } from "./http";
import { decryptPlaylist, encryptPlaylist } from "./playlist-crypto";
import { ProviderError } from "./provider-http";
import { withViewing } from "./viewing";

export const itemSummary = {
	id: true,
	kind: true,
	title: true,
	category: true,
	season: true,
	episode: true,
	parentId: true,
} as const;
function itemId(playlistId: string, key: string) {
	return createHash("sha256").update(`${playlistId}:${key}`).digest("hex");
}
function data(playlistId: string, item: SourceItem) {
	const id = itemId(playlistId, item.sourceKey);
	return {
		id,
		playlistId,
		sourceKey: item.sourceKey,
		kind: item.kind,
		title: item.title,
		category: item.category,
		season: item.season,
		episode: item.episode,
		parentId: item.parentKey ? itemId(playlistId, item.parentKey) : null,
		encryptedLocator: encryptPlaylist(id, item.locator),
	};
}
export async function activeSource(userId: string) {
	const selected = await getDb().playlistSelection.findUnique({
		where: { userId },
		include: { assignment: { include: { playlist: true } } },
	});
	if (!selected) throw new HttpError(404, "Nema aktivne liste.");
	return selected.assignment.playlist;
}
const refreshState = globalThis as unknown as {
	catalogRefreshRunning?: boolean;
};
export async function refreshCatalog(playlistId: string, revision: number) {
	if (refreshState.catalogRefreshRunning)
		throw new HttpError(
			409,
			"Učitavanje druge liste je u toku. Sačekajte završetak, pa pokušajte ponovo.",
		);
	refreshState.catalogRefreshRunning = true;
	try {
		return await performRefresh(playlistId, revision);
	} finally {
		refreshState.catalogRefreshRunning = false;
	}
}
async function performRefresh(playlistId: string, revision: number) {
	const source = await getDb().playlist.findUnique({
		where: { id: playlistId },
	});
	if (!source) throw new HttpError(404, "Lista nije pronađena.");
	if (source.revision !== revision)
		throw new HttpError(409, "Lista je promenjena. Osvežite prikaz.");
	let items: SourceItem[];
	try {
		items = await loadCatalog(
			playlistInput.parse(decryptPlaylist(source.id, source.encryptedInput)),
		);
	} catch (error) {
		const reason =
			error instanceof ProviderError
				? {
						address: "Adresa servera nije dostupna ili nije dozvoljena.",
						timeout: "Server liste nije odgovorio na vreme. Pokušajte ponovo.",
						upstream: "Server liste je odbio zahtev ili je veza prekinuta.",
						size: "Lista prelazi podržanu veličinu uvoza.",
						format:
							"Server nije vratio ispravan katalog. Proverite pristupne podatke.",
					}[error.code]
				: "Učitavanje liste nije uspelo.";
		throw new HttpError(502, `${reason} Prethodni katalog je sačuvan.`);
	}
	await getDb().$transaction(
		async (tx) => {
			const current = await tx.playlist.findUnique({
				where: { id: playlistId },
			});
			if (!current || current.revision !== revision)
				throw new HttpError(409, "Lista je promenjena tokom učitavanja.");
			await tx.catalogItem.deleteMany({ where: { playlistId } });
			// Encrypt only the current insert batch instead of retaining a second
			// full catalog in memory alongside the parsed source records.
			for (let i = 0; i < items.length; i += 500)
				await tx.catalogItem.createMany({
					data: items.slice(i, i + 500).map((item) => data(playlistId, item)),
				});
			await tx.playlist.update({
				where: { id: playlistId },
				data: { catalogRevision: revision, catalogUpdatedAt: new Date() },
			});
		},
		{
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			timeout: 120000,
		},
	);
	return { count: items.length };
}
export async function catalog(
	userId: string,
	query: {
		kind: string;
		search: string;
		category: string;
		page: number;
		favorites?: boolean;
	},
) {
	const source = await activeSource(userId);
	if (source.catalogRevision !== source.revision)
		return {
			items: [],
			total: 0,
			categories: [],
			ready: false,
			sourceName: source.name,
		};
	const favorites = query.favorites
		? await getDb().viewingState.findMany({
				where: {
					userId,
					playlistId: source.id,
					providerKey: source.providerKey,
					favorite: true,
				},
				select: { itemId: true, favoriteOrder: true },
			})
		: null;
	const allowed = visibleCategories(source.categoryVisibility, query.kind);
	const visible = allowed === null ? {} : { category: { in: allowed } };
	const where = {
		AND: [visible],
		...(favorites ? { id: { in: favorites.map((row) => row.itemId) } } : {}),
		playlistId: source.id,
		kind: query.kind,
		...(query.search
			? { title: { contains: query.search, mode: "insensitive" as const } }
			: {}),
		...(query.category ? { category: query.category } : {}),
	};
	const [items, total, groups] = await Promise.all([
		getDb().catalogItem.findMany({
			where,
			select: itemSummary,
			orderBy: [{ title: "asc" }, { id: "asc" }],
			...(favorites && query.kind === "tv"
				? {}
				: { skip: query.page * 60, take: 60 }),
		}),
		getDb().catalogItem.count({ where }),
		getDb().catalogItem.groupBy({
			by: ["category"],
			where: { playlistId: source.id, kind: query.kind, ...visible },
			orderBy: { category: "asc" },
			take: 1000,
		}),
	]);
	const ranks = new Map(
		favorites?.map((row) => [row.itemId, row.favoriteOrder]),
	);
	const orderedItems =
		favorites && query.kind === "tv"
			? items
					.sort(
						(a, b) =>
							(ranks.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
							(ranks.get(b.id) ?? Number.MAX_SAFE_INTEGER),
					)
					.slice(query.page * 60, (query.page + 1) * 60)
			: items;
	return {
		items: await withViewing(
			userId,
			source.id,
			source.providerKey,
			orderedItems,
		),
		total,
		categories: groups.map((g) => g.category),
		ready: true,
		sourceName: source.name,
	};
}
export async function authorizedItem(userId: string, itemId: string) {
	const source = await activeSource(userId);
	if (source.catalogRevision !== source.revision)
		throw new HttpError(409, "Administrator treba da osveži katalog liste.");
	const item = await getDb().catalogItem.findFirst({
		where: { id: itemId, playlistId: source.id },
	});
	if (!item) throw new HttpError(404, "Sadržaj nije dostupan.");
	const visibilityItem =
		item.kind === "episode" && item.parentId
			? await getDb().catalogItem.findFirst({
					where: { id: item.parentId, playlistId: source.id, kind: "series" },
				})
			: item;
	const allowed = visibleCategories(source.categoryVisibility, item.kind);
	if (
		!visibilityItem ||
		(allowed !== null && !allowed.includes(visibilityItem.category))
	)
		throw new HttpError(404, "Sadržaj nije dostupan.");
	return {
		source,
		item,
		locator: decryptPlaylist(item.id, item.encryptedLocator) as {
			url?: string;
			artwork?: string;
			seriesId?: string;
			details?: { fetchedAt: number; value: MediaDetails };
		},
	};
}
// Share in-flight lookups across route bundles, with no queue retaining work.
const lookupState = globalThis as unknown as {
	catalogLookups?: Map<string, Promise<unknown>>;
};
lookupState.catalogLookups ??= new Map();
const lookups = lookupState.catalogLookups;
function lookupKey(
	kind: string,
	source: { id: string; revision: number },
	item: { id: string; encryptedLocator: string },
) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				kind,
				source.id,
				source.revision,
				item.id,
				item.encryptedLocator,
			]),
		)
		.digest("hex");
}
async function boundedLookup<T>(
	key: string,
	action: () => Promise<T>,
): Promise<T> {
	const existing = lookups.get(key);
	if (existing) return existing as Promise<T>;
	if (lookups.size >= 2)
		throw new HttpError(
			503,
			"Učitavanje detalja je zauzeto. Pokušajte ponovo.",
		);
	const pending = Promise.resolve().then(action);
	lookups.set(key, pending);
	try {
		return await pending;
	} finally {
		lookups.delete(key);
	}
}
export async function episodes(userId: string, id: string) {
	const { source, item, locator } = await authorizedItem(userId, id);
	if (item.kind !== "series") throw new HttpError(400, "Nije serija.");
	let result = await getDb().catalogItem.findMany({
		where: { playlistId: source.id, parentId: id },
		select: itemSummary,
		orderBy: [{ season: "asc" }, { episode: "asc" }],
	});
	if (!result.length && locator.seriesId) {
		const seriesId = locator.seriesId;
		const input = playlistInput.parse(
			decryptPlaylist(source.id, source.encryptedInput),
		);
		if (input.kind !== "xtream") throw new HttpError(400, "Nepodržan izvor.");
		result = await boundedLookup(
			lookupKey("episodes", source, item),
			async () => {
				let rows: ReturnType<typeof data>[];
				try {
					rows = (await loadEpisodes(input, seriesId, item.sourceKey)).map(
						(row) => data(source.id, row),
					);
				} catch {
					throw new HttpError(502, "Epizode trenutno nisu dostupne.");
				}
				await getDb().$transaction(
					async (tx) => {
						const current = await tx.playlist.findUnique({
							where: { id: source.id },
						});
						if (current?.revision !== source.revision)
							throw new HttpError(409, "Lista je promenjena.");
						await tx.catalogItem.createMany({
							data: rows,
							skipDuplicates: true,
						});
					},
					{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
				);
				return await getDb().catalogItem.findMany({
					where: { playlistId: source.id, parentId: id },
					select: itemSummary,
					orderBy: [{ season: "asc" }, { episode: "asc" }],
				});
			},
		);
	}
	return {
		items: await withViewing(userId, source.id, source.providerKey, result),
	};
}

export async function mediaDetails(
	userId: string,
	id: string,
): Promise<MediaDetails> {
	const { source, item, locator } = await authorizedItem(userId, id);
	if (item.kind !== "movie" && item.kind !== "series")
		throw new HttpError(400, "Detalji nisu dostupni za ovaj sadržaj.");
	const input = playlistInput.parse(
		decryptPlaylist(source.id, source.encryptedInput),
	);
	if (input.kind !== "xtream") return parseMediaDetails(null, item.title);
	if (
		locator.details &&
		Date.now() - locator.details.fetchedAt < 24 * 3600 * 1000
	)
		return locator.details.value;
	const sourceId =
		item.kind === "series"
			? locator.seriesId
			: item.sourceKey.match(/^movie:(\d+)$/)?.[1];
	if (!sourceId) return parseMediaDetails(null, item.title);
	const kind = item.kind;
	return boundedLookup(lookupKey("details", source, item), async () => {
		let details: MediaDetails;
		try {
			details = await loadMediaDetails(input, kind, sourceId, item.title);
		} catch {
			throw new HttpError(
				502,
				"Opis trenutno nije dostupan. Možete ipak pokrenuti gledanje.",
			);
		}
		// Compare the encrypted snapshot as well as its source revision: a refresh or
		// concurrent lookup must never overwrite a newer catalog locator.
		await getDb().catalogItem.updateMany({
			where: {
				id: item.id,
				encryptedLocator: item.encryptedLocator,
				playlist: {
					revision: source.revision,
					catalogRevision: source.revision,
				},
			},
			data: {
				encryptedLocator: encryptPlaylist(item.id, {
					...locator,
					details: { fetchedAt: Date.now(), value: details },
				}),
			},
		});
		return details;
	});
}
