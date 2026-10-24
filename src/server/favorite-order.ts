import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { visibleCategories } from "../lib/category-visibility";
import { activeSource } from "./catalog";
import { getDb } from "./db";
import { HttpError } from "./http";

export async function swapFavoriteChannels(
	userId: string,
	itemId: string,
	neighborId: string,
	direction: -1 | 1,
) {
	const source = await activeSource(userId);
	if (source.catalogRevision !== source.revision)
		throw new HttpError(409, "Administrator treba da osveži katalog liste.");
	const allowed = visibleCategories(source.categoryVisibility, "tv");
	try {
		await getDb().$transaction(
			async (tx) => {
				const scope = {
					userId,
					playlistId: source.id,
					providerKey: source.providerKey,
					favorite: true,
				};
				const favorites = await tx.viewingState.findMany({
					where: scope,
					select: { itemId: true, favoriteOrder: true },
				});
				const channels = await tx.catalogItem.findMany({
					where: {
						playlistId: source.id,
						kind: "tv",
						id: { in: favorites.map((row) => row.itemId) },
						...(allowed === null ? {} : { category: { in: allowed } }),
					},
					select: { id: true },
					orderBy: [{ title: "asc" }, { id: "asc" }],
				});
				const ranks = new Map(
					favorites.map((row) => [row.itemId, row.favoriteOrder]),
				);
				channels.sort(
					(a, b) =>
						(ranks.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
						(ranks.get(b.id) ?? Number.MAX_SAFE_INTEGER),
				);
				const index = channels.findIndex((row) => row.id === itemId);
				const neighbor = channels.findIndex((row) => row.id === neighborId);
				if (index < 0 || neighbor < 0)
					throw new HttpError(404, "Omiljeni kanal nije dostupan.");
				if (neighbor !== index + direction)
					throw new HttpError(
						409,
						"Redosled je promenjen. Osvežite listu i pokušajte ponovo.",
					);
				[channels[index], channels[neighbor]] = [
					channels[neighbor],
					channels[index],
				];
				const positions = JSON.stringify(
					channels.map((row, order) => ({ id: row.id, rank: order })),
				);
				// One statement, scoped to this user's current source; no catalog rows are changed.
				await tx.$executeRaw`UPDATE "viewingState" AS state SET "favoriteOrder" = ordering.rank
				FROM jsonb_to_recordset(${positions}::jsonb) AS ordering(id text, rank integer)
				WHERE state."userId" = ${userId} AND state."playlistId" = ${source.id}
				AND state."providerKey" = ${source.providerKey} AND state.favorite = true AND state."itemId" = ordering.id`;
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
		);
	} catch (error) {
		if (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === "P2034"
		)
			throw new HttpError(
				409,
				"Redosled je promenjen. Osvežite listu i pokušajte ponovo.",
			);
		throw error;
	}
	return { saved: true };
}
