import { type APIRequestContext, expect } from "@playwright/test";

export async function checkViewing(
	owner: APIRequestContext,
	viewer: APIRequestContext,
	anonymous: APIRequestContext,
	itemId: string,
	otherId: string,
	leaseId: string,
	sourceId: string,
) {
	const favorite = `/api/catalog/${itemId}/favorite`;
	const progress = `/api/playback/${leaseId}/progress`;
	const data = { itemId, position: 40, duration: 120 };
	expect(
		(await anonymous.put(favorite, { data: { favorite: true } })).status(),
	).toBe(401);
	expect((await viewer.put(favorite, { data: { favorite: true } })).ok()).toBe(
		true,
	);
	expect((await viewer.post(progress, { data })).ok()).toBe(true);
	expect((await owner.post(progress, { data })).status()).toBe(410);
	expect((await anonymous.post(progress, { data })).status()).toBe(401);
	expect(
		(
			await viewer.post(progress, { data: { ...data, itemId: otherId } })
		).status(),
	).toBe(403);
	expect(
		(
			await viewer.post(progress, { data: { ...data, position: 200 } })
		).status(),
	).toBe(400);
	expect(
		(await viewer.post(progress, { data: { ...data, position: -1 } })).status(),
	).toBe(400);
	expect(
		(
			await viewer.post(progress, {
				headers: { Origin: "https://other.invalid" },
				data,
			})
		).status(),
	).toBe(403);
	const own = await (
		await viewer.get("/api/catalog?kind=movie&favorites=1")
	).json();
	expect(own.items.map((item: { id: string }) => item.id)).toEqual([itemId]);
	expect(own.items[0].position).toBe(40);
	const separate = await (
		await owner.get("/api/catalog?kind=movie&favorites=1")
	).json();
	expect(separate.items).toHaveLength(0);
	// Atomic catalog replacement must retain state for stable source/item identities.
	expect(
		(
			await owner.post(`/api/admin/playlists/${sourceId}/refresh`, {
				data: { revision: 1 },
			})
		).ok(),
	).toBe(true);
	const refreshed = await (
		await viewer.get("/api/catalog?kind=movie&favorites=1")
	).json();
	expect(refreshed.items[0].position).toBe(40);
	expect(
		(
			await viewer.post(progress, {
				data: { ...data, position: 120, completed: true },
			})
		).ok(),
	).toBe(true);
	const complete = await (
		await viewer.get("/api/catalog?kind=movie&favorites=1")
	).json();
	expect(complete.items[0].completed).toBe(true);
	expect(complete.items[0].position).toBe(0);
	// Restore a fresh start for the short generated browser fixtures.
	expect(
		(
			await viewer.post(progress, {
				data: { ...data, position: 0, completed: false },
			})
		).ok(),
	).toBe(true);
	expect((await viewer.put(favorite, { data: { favorite: false } })).ok()).toBe(
		true,
	);
}
