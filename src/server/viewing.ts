import "server-only";
import { authorizedItem } from "./catalog";
import { getDb } from "./db";
import { HttpError } from "./http";
import { checkLease } from "./playback";

export async function withViewing<T extends { id: string }>(
	userId: string,
	playlistId: string,
	providerKey: string,
	items: T[],
) {
	const rows = await getDb().viewingState.findMany({
		where: {
			userId,
			playlistId,
			providerKey,
			itemId: { in: items.map((item) => item.id) },
		},
	});
	const states = new Map(rows.map((row) => [row.itemId, row]));
	return items.map((item) => {
		const state = states.get(item.id);
		return {
			...item,
			favorite: state?.favorite ?? false,
			position: state?.completed ? 0 : (state?.position ?? 0),
			duration: state?.duration ?? 0,
			completed: state?.completed ?? false,
		};
	});
}
export async function setFavorite(
	userId: string,
	itemId: string,
	favorite: boolean,
) {
	const { source } = await authorizedItem(userId, itemId);
	const key = {
		userId,
		playlistId: source.id,
		providerKey: source.providerKey,
		itemId,
	};
	await getDb().viewingState.upsert({
		where: { userId_playlistId_providerKey_itemId: key },
		create: { ...key, favorite },
		update: { favorite, ...(!favorite ? { favoriteOrder: null } : {}) },
	});
	return { favorite };
}
export async function saveProgress(
	userId: string,
	sessionId: string,
	leaseId: string,
	data: {
		itemId: string;
		position: number;
		duration: number;
		completed?: boolean;
	},
) {
	const lease = await checkLease(userId, sessionId, leaseId);
	if (lease.itemId !== data.itemId)
		throw new HttpError(403, "Sadržaj ne pripada ovoj reprodukciji.");
	const item = await getDb().catalogItem.findUnique({
		where: { id: data.itemId },
		select: { kind: true },
	});
	if (!item || !["movie", "episode"].includes(item.kind))
		throw new HttpError(400, "Pozicija se čuva samo za filmove i epizode.");
	if (data.position > data.duration + 2)
		throw new HttpError(400, "Neispravna pozicija.");
	const completed =
		data.completed === true ||
		(data.duration > 30 && data.position >= data.duration - 10);
	const key = {
		userId,
		playlistId: lease.playlistId,
		providerKey: lease.providerKey,
		itemId: lease.itemId,
	};
	const progress = {
		position: Math.min(data.position, data.duration),
		duration: data.duration,
		completed,
	};
	await getDb().viewingState.upsert({
		where: { userId_playlistId_providerKey_itemId: key },
		create: { ...key, ...progress },
		update: progress,
	});
	return { saved: true, ...progress };
}
