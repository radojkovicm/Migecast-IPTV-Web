import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { normalizePlaylist, type PlaylistInput } from "@/lib/playlist-input";
import { getDb } from "./db";
import { HttpError } from "./http";
import { abortMedia } from "./media-connections";
import {
	encryptPlaylist,
	playlistIdentity,
	playlistKey,
} from "./playlist-crypto";
import { stopWorker } from "./worker-client";

const summary = {
	id: true,
	name: true,
	kind: true,
	revision: true,
	entryCount: true,
	catalogRevision: true,
	catalogUpdatedAt: true,
	updatedAt: true,
} as const;

async function transaction<T>(
	action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await getDb().$transaction(action, {
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			});
		} catch (error) {
			if (
				error instanceof Prisma.PrismaClientKnownRequestError &&
				error.code === "P2034"
			) {
				if (attempt < 2) continue;
				throw new HttpError(409, "Podaci su promenjeni. Osvežite prikaz.");
			}
			throw error;
		}
	}
	throw new HttpError(409, "Pokušajte ponovo.");
}
function prepare(id: string, input: PlaylistInput) {
	let normalized: ReturnType<typeof normalizePlaylist>;
	try {
		normalized = normalizePlaylist(input);
	} catch (error) {
		throw new HttpError(
			400,
			error instanceof Error ? error.message : "Neispravna lista.",
		);
	}
	let key: Buffer;
	try {
		key = playlistKey();
	} catch {
		throw new HttpError(503, "Čuvanje listi još nije podešeno na serveru.");
	}
	return {
		kind: normalized.kind,
		entryCount: normalized.entryCount,
		encryptedInput: encryptPlaylist(id, normalized.input, key),
		providerKey: playlistIdentity(normalized.identity, key),
	};
}
export async function listOwnPlaylists(userId: string) {
	return getDb().$transaction(
		async (tx) => ({
			playlists: (
				await tx.playlistAssignment.findMany({
					where: { userId },
					select: { playlist: { select: summary } },
					orderBy: { playlist: { name: "asc" } },
				})
			).map((row) => row.playlist),
			activePlaylistId:
				(await tx.playlistSelection.findUnique({ where: { userId } }))
					?.playlistId ?? null,
		}),
		{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
	);
}
export async function adminPlaylists() {
	return getDb().$transaction(
		async (tx) => ({
			playlists: await tx.playlist.findMany({
				select: {
					...summary,
					_count: { select: { assignments: true, catalogItems: true } },
				},
				orderBy: { createdAt: "desc" },
			}),
			users: await tx.user.findMany({
				select: {
					id: true,
					name: true,
					username: true,
					playlistRevision: true,
					playlistAssignments: { select: { playlistId: true } },
					playlistSelection: { select: { playlistId: true } },
				},
				orderBy: { name: "asc" },
			}),
		}),
		{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
	);
}
export async function savePlaylist(name: string, input: PlaylistInput) {
	const id = randomUUID();
	return getDb().playlist.create({
		data: { id, name, ...prepare(id, input) },
		select: summary,
	});
}
export async function updatePlaylist(
	id: string,
	data: { name: string; revision: number; input?: PlaylistInput },
) {
	const replacement = data.input ? prepare(id, data.input) : {};
	return transaction(async (tx) => {
		const existing = await tx.playlist.findUnique({
			where: { id },
			select: { revision: true, catalogRevision: true },
		});
		if (!existing) throw new HttpError(404, "Lista nije pronađena.");
		if (existing.revision !== data.revision)
			throw new HttpError(409, "Lista je promenjena. Osvežite prikaz.");
		return tx.playlist.update({
			where: { id },
			data: {
				name: data.name,
				...replacement,
				revision: { increment: 1 },
				...(!data.input && existing.catalogRevision === existing.revision
					? { catalogRevision: existing.revision + 1 }
					: {}),
			},
			select: summary,
		});
	});
}
export async function deletePlaylist(
	id: string,
	revision: number,
	detach: boolean,
) {
	const result = await transaction(async (tx) => {
		const source = await tx.playlist.findUnique({
			where: { id },
			select: { revision: true, assignments: { select: { userId: true } } },
		});
		if (!source) throw new HttpError(404, "Lista nije pronađena.");
		if (source.revision !== revision)
			throw new HttpError(409, "Lista je promenjena. Osvežite prikaz.");
		if (source.assignments.length && !detach)
			throw new HttpError(
				409,
				"Lista je dodeljena korisnicima. Potvrdite uklanjanje pristupa i aktivnog izbora.",
			);
		await tx.user.updateMany({
			where: { id: { in: source.assignments.map((row) => row.userId) } },
			data: { playlistRevision: { increment: 1 } },
		});
		const leases = await tx.playbackLease.findMany({
			where: { playlistId: id },
			select: { id: true, workerJobId: true },
		});
		await tx.playbackLease.deleteMany({ where: { playlistId: id } });
		// Cascades remove assignments and their active selections in this transaction.
		await tx.playlist.delete({ where: { id } });
		return { value: { deleted: true }, leases };
	});
	await stopRemovedLeases(result.leases);
	return result.value;
}
export async function assignPlaylists(
	userId: string,
	data: { playlistIds: string[]; revision: number; deactivate: boolean },
) {
	const result = await transaction(async (tx) => {
		const user = await tx.user.findUnique({
			where: { id: userId },
			select: { playlistRevision: true, playlistSelection: true },
		});
		if (!user) throw new HttpError(404, "Korisnik nije pronađen.");
		if (user.playlistRevision !== data.revision)
			throw new HttpError(409, "Dodela je promenjena. Osvežite prikaz.");
		if (
			user.playlistSelection &&
			!data.playlistIds.includes(user.playlistSelection.playlistId) &&
			!data.deactivate
		)
			throw new HttpError(
				409,
				"Aktivna lista se uklanja. Potvrdite deaktivaciju ili prvo izaberite drugu listu.",
			);
		if (
			(await tx.playlist.count({ where: { id: { in: data.playlistIds } } })) !==
			data.playlistIds.length
		)
			throw new HttpError(404, "Jedna od listi više ne postoji.");
		const leases = await tx.playbackLease.findMany({
			where: { userId, playlistId: { notIn: data.playlistIds } },
			select: { id: true, workerJobId: true },
		});
		await tx.playbackLease.deleteMany({
			where: { userId, playlistId: { notIn: data.playlistIds } },
		});
		await tx.playlistAssignment.deleteMany({
			where: { userId, playlistId: { notIn: data.playlistIds } },
		});
		await tx.playlistAssignment.createMany({
			data: data.playlistIds.map((playlistId) => ({ userId, playlistId })),
			skipDuplicates: true,
		});
		await tx.user.update({
			where: { id: userId },
			data: { playlistRevision: { increment: 1 } },
		});
		return { value: { saved: true }, leases };
	});
	await stopRemovedLeases(result.leases);
	return result.value;
}
export async function selectPlaylist(
	userId: string,
	data: { playlistId: string | null; revision: number },
) {
	const result = await transaction(async (tx) => {
		const user = await tx.user.findUnique({
			where: { id: userId },
			select: { playlistRevision: true },
		});
		if (!user) throw new HttpError(404, "Korisnik nije pronađen.");
		if (user.playlistRevision !== data.revision)
			throw new HttpError(409, "Aktivna lista je promenjena. Osvežite prikaz.");
		if (data.playlistId) {
			if (
				!(await tx.playlistAssignment.findUnique({
					where: { userId_playlistId: { userId, playlistId: data.playlistId } },
				}))
			)
				throw new HttpError(403, "Lista nije dodeljena ovom korisniku.");
			await tx.playlistSelection.upsert({
				where: { userId },
				create: { userId, playlistId: data.playlistId },
				update: { playlistId: data.playlistId },
			});
		} else {
			await tx.playlistSelection.deleteMany({ where: { userId } });
		}
		await tx.user.update({
			where: { id: userId },
			data: { playlistRevision: { increment: 1 } },
		});
		const leases = await tx.playbackLease.findMany({
			where: { userId },
			select: { id: true, workerJobId: true },
		});
		await tx.playbackLease.deleteMany({ where: { userId } });
		return { value: { activePlaylistId: data.playlistId }, leases };
	});
	await stopRemovedLeases(result.leases);
	return result.value;
}

async function stopRemovedLeases(
	leases: { id: string; workerJobId: string | null }[],
) {
	await Promise.all(
		leases.map(async (lease) => {
			abortMedia(lease.id);
			try {
				await stopWorker(lease.workerJobId);
			} catch {
				console.warn(
					"Media worker cleanup pending; independent job expiry remains active.",
				);
			}
		}),
	);
}

export async function playlistCategories(id: string) {
	const source = await getDb().playlist.findUnique({
		where: { id },
		select: {
			categoryVisibility: true,
			visibilityRevision: true,
			revision: true,
		},
	});
	if (!source) throw new HttpError(404, "Lista nije pronađena.");
	const categories = await getDb().catalogItem.groupBy({
		by: ["kind", "category"],
		where: { playlistId: id, kind: { in: ["tv", "movie", "series"] } },
		_count: { _all: true },
		orderBy: [{ kind: "asc" }, { category: "asc" }],
		take: 20001,
	});
	if (categories.length > 20000)
		throw new HttpError(413, "Lista ima previše kategorija.");
	return {
		visibility: source.categoryVisibility,
		revision: source.visibilityRevision,
		sourceRevision: source.revision,
		categories: categories.map((row) => ({
			kind: row.kind,
			name: row.category,
			count: row._count._all,
		})),
	};
}
export async function savePlaylistCategories(
	id: string,
	data: {
		revision: number;
		sourceRevision: number;
		visibility: import("@/lib/category-visibility").CategoryVisibility;
	},
) {
	const result = await transaction(async (tx) => {
		const source = await tx.playlist.findUnique({ where: { id } });
		if (!source) throw new HttpError(404, "Lista nije pronađena.");
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider:${source.providerKey}`}))`;
		const changed = await tx.playlist.updateMany({
			where: {
				id,
				revision: data.sourceRevision,
				visibilityRevision: data.revision,
			},
			data: {
				categoryVisibility: data.visibility,
				visibilityRevision: { increment: 1 },
			},
		});
		if (!changed.count)
			throw new HttpError(
				409,
				"Podešavanja su promenjena. Ponovo otvorite kategorije.",
			);
		const leases = await tx.playbackLease.findMany({
			where: { playlistId: id },
			select: { id: true, workerJobId: true },
		});
		await tx.playbackLease.deleteMany({ where: { playlistId: id } });
		return leases;
	});
	await stopRemovedLeases(result);
	return { saved: true };
}
