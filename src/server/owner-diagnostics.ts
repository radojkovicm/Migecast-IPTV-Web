import "server-only";
import { visibleCategories } from "../lib/category-visibility";
import { getDb } from "./db";
import { workerRequest } from "./worker-client";

const limit = 100;
const kinds = ["tv", "movie", "series"] as const;

async function workerHealth() {
	try {
		const response = await workerRequest("/health");
		const value = await response.json();
		return {
			ready: value.ready === true,
			jobs:
				Number.isSafeInteger(value.jobs) && value.jobs >= 0
					? (value.jobs as number)
					: null,
			maxJobs:
				Number.isSafeInteger(value.maxJobs) && value.maxJobs > 0
					? (value.maxJobs as number)
					: null,
		};
	} catch {
		return { ready: false, jobs: null, maxJobs: null };
	}
}

/** Read-only metadata; never probe a provider or expose its identity/credentials. */
export async function ownerDiagnostics() {
	const db = getDb();
	const now = new Date();
	const [users, playlists, leases, worker] = await Promise.all([
		db.user.findMany({
			select: {
				id: true,
				name: true,
				username: true,
				banned: true,
				banExpires: true,
				playlistSelection: { select: { playlistId: true } },
				_count: { select: { playlistAssignments: true } },
			},
			orderBy: { createdAt: "asc" },
			take: limit + 1,
		}),
		db.playlist.findMany({
			select: {
				id: true,
				name: true,
				providerKey: true,
				revision: true,
				catalogRevision: true,
				catalogUpdatedAt: true,
				categoryVisibility: true,
			},
			orderBy: { name: "asc" },
			take: limit + 1,
		}),
		db.playbackLease.findMany({
			where: { expiresAt: { gt: now } },
			select: { userId: true, playlistId: true, providerKey: true },
			orderBy: { createdAt: "asc" },
			take: limit + 1,
		}),
		workerHealth(),
	]);
	const shownUsers = users.slice(0, limit);
	const shownLists = playlists.slice(0, limit);
	const [counts, sessions] = await Promise.all([
		db.catalogItem.groupBy({
			by: ["playlistId", "kind"],
			where: {
				playlistId: { in: shownLists.map((list) => list.id) },
				kind: { in: [...kinds] },
			},
			_count: { _all: true },
		}),
		db.session.groupBy({
			by: ["userId"],
			where: {
				userId: { in: shownUsers.map((user) => user.id) },
				expiresAt: { gt: now },
			},
			_count: { _all: true },
			_max: { updatedAt: true },
		}),
	]);
	const userName = (id: string) => {
		const user = shownUsers.find((candidate) => candidate.id === id);
		return user?.username ?? user?.name ?? "Drugi korisnik";
	};
	const listResults = shownLists.map((list) => {
		const lease = leases.find(
			(lease) => lease.providerKey === list.providerKey,
		);
		return {
			id: list.id,
			name: list.name,
			catalogReady: list.catalogRevision === list.revision,
			catalogUpdatedAt: list.catalogUpdatedAt?.toISOString() ?? null,
			sections: kinds.map((kind) => ({
				kind,
				items:
					counts.find(
						(count) => count.playlistId === list.id && count.kind === kind,
					)?._count._all ?? 0,
				allowedCategories:
					visibleCategories(list.categoryVisibility, kind)?.length ?? null,
			})),
			occupiedBy: lease ? userName(lease.userId) : null,
			occupiedPlaylistId: lease?.playlistId ?? null,
		};
	});
	return {
		checkedAt: now.toISOString(),
		worker,
		limited:
			users.length > limit || playlists.length > limit || leases.length > limit,
		playlists: listResults,
		users: shownUsers.map((user) => {
			const selected = shownLists.find(
				(list) => list.id === user.playlistSelection?.playlistId,
			);
			const lease = selected
				? leases.find((lease) => lease.providerKey === selected.providerKey)
				: undefined;
			const session = sessions.find((session) => session.userId === user.id);
			return {
				id: user.id,
				name: user.name,
				username: user.username,
				blocked:
					user.banned === true && (!user.banExpires || user.banExpires > now),
				assignedLists: user._count.playlistAssignments,
				activePlaylistId: user.playlistSelection?.playlistId ?? null,
				activePlaylistName: selected?.name ?? null,
				activeSessions: session?._count._all ?? 0,
				lastSessionActivity: session?._max.updatedAt?.toISOString() ?? null,
				playing: leases.some((lease) => lease.userId === user.id),
				blockedBy:
					lease && lease.userId !== user.id ? userName(lease.userId) : null,
			};
		}),
	};
}

export type OwnerDiagnosticsData = Awaited<ReturnType<typeof ownerDiagnostics>>;
