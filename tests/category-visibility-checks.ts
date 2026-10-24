import { type APIRequestContext, expect, type Page } from "@playwright/test";
export async function checkCategoryVisibility(
	owner: APIRequestContext,
	viewer: APIRequestContext,
	anonymous: APIRequestContext,
	userId: string,
	page: Page,
) {
	const created = await owner.post("/api/admin/playlists", {
		data: {
			name: "Category visibility fixture",
			input: {
				kind: "file",
				content:
					'#EXTM3U\n#EXTINF:-1 group-title="News",Visible news\nhttps://example.invalid/news.m3u8\n#EXTINF:-1 group-title="Other",Hidden news\nhttps://example.invalid/other.m3u8\n',
			},
		},
	});
	expect(created.status()).toBe(201);
	const source = await created.json();
	expect(
		(
			await owner.post(`/api/admin/playlists/${source.id}/refresh`, {
				data: { revision: source.revision },
			})
		).ok(),
	).toBe(true);
	const user = (
		await (await owner.get("/api/admin/playlists")).json()
	).users.find((u: { id: string }) => u.id === userId);
	expect(
		(
			await owner.put(`/api/admin/users/${userId}/playlists`, {
				data: {
					playlistIds: [
						...new Set([
							...user.playlistAssignments.map(
								(p: { playlistId: string }) => p.playlistId,
							),
							source.id,
						]),
					],
					revision: user.playlistRevision,
				},
			})
		).ok(),
	).toBe(true);
	const next = (
		await (await owner.get("/api/admin/playlists")).json()
	).users.find((u: { id: string }) => u.id === userId);
	expect(
		(
			await owner.put(`/api/admin/users/${userId}/active-playlist`, {
				data: { playlistId: source.id, revision: next.playlistRevision },
			})
		).ok(),
	).toBe(true);
	const endpoint = `/api/admin/playlists/${source.id}/categories`;
	expect((await anonymous.get(endpoint)).status()).toBe(401);
	expect((await viewer.get(endpoint)).status()).toBe(403);
	const config = await (await owner.get(endpoint)).json();
	expect(config.categories.map((c: { name: string }) => c.name)).toEqual([
		"News",
		"Other",
	]);
	const all = await (await viewer.get("/api/catalog?kind=tv")).json();
	const orderEndpoint = "/api/catalog/favorite-order";
	const orderData = {
		itemId: all.items[0].id,
		neighborId: all.items[1].id,
		direction: 1,
	};
	expect(
		(await anonymous.put(orderEndpoint, { data: orderData })).status(),
	).toBe(401);
	expect((await viewer.put(orderEndpoint, { data: orderData })).status()).toBe(
		404,
	);
	for (const item of all.items) {
		expect(
			(
				await viewer.put(`/api/catalog/${item.id}/favorite`, {
					data: { favorite: true },
				})
			).ok(),
		).toBe(true);
	}
	// An owner cannot reorder another user's favorites without an assigned source.
	expect((await owner.put(orderEndpoint, { data: orderData })).ok()).toBe(
		false,
	);
	expect(
		(
			await viewer.put(orderEndpoint, {
				data: { ...orderData, neighborId: orderData.itemId },
			})
		).status(),
	).toBe(409);
	await page.goto(`${process.env.TEST_BASE_URL}/gledaj/tv`);
	await page
		.getByRole("button", { name: "Uredi redosled", exact: true })
		.click();
	const firstTitle = all.items[0].title;
	const secondTitle = all.items[1].title;
	await expect(
		page.getByRole("button", {
			name: `Pomeri gore: ${firstTitle}`,
			exact: true,
		}),
	).toBeDisabled();
	await page
		.getByRole("button", { name: `Pomeri gore: ${secondTitle}`, exact: true })
		.click();
	await expect(page.locator(".channel-choice").first()).toHaveAccessibleName(
		secondTitle,
	);
	expect((await viewer.put(orderEndpoint, { data: orderData })).status()).toBe(
		409,
	);
	const viewport = page.viewportSize();
	await page.setViewportSize({ width: 390, height: 844 });
	const moveButton = page.getByRole("button", {
		name: `Pomeri dole: ${secondTitle}`,
		exact: true,
	});
	await moveButton.scrollIntoViewIfNeeded();
	const bounds = await moveButton.boundingBox();
	expect(bounds).not.toBeNull();
	expect(bounds!.width).toBeGreaterThanOrEqual(44);
	expect(bounds!.height).toBeGreaterThanOrEqual(44);
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
	if (process.env.TEST_SCREENSHOT_DIR)
		await page.screenshot({
			path: `${process.env.TEST_SCREENSHOT_DIR}/favorite-order-mobile.png`,
			fullPage: true,
		});
	if (viewport) await page.setViewportSize(viewport);
	await page.getByRole("button", { name: "Gotovo", exact: true }).click();
	await page.reload();
	await expect(page.locator(".channel-choice").first()).toHaveAccessibleName(
		secondTitle,
	);
	const reordered = await (
		await viewer.get("/api/catalog?kind=tv&favorites=1")
	).json();
	expect(reordered.items.map((item: { id: string }) => item.id)).toEqual([
		orderData.neighborId,
		orderData.itemId,
	]);
	// Catalog refresh keeps source-stable favorites and their order.
	expect(
		(
			await owner.post(`/api/admin/playlists/${source.id}/refresh`, {
				data: { revision: source.revision },
			})
		).ok(),
	).toBe(true);
	expect(
		(
			await (await viewer.get("/api/catalog?kind=tv&favorites=1")).json()
		).items.map((item: { id: string }) => item.id),
	).toEqual([orderData.neighborId, orderData.itemId]);
	for (const item of all.items)
		await viewer.put(`/api/catalog/${item.id}/favorite`, {
			data: { favorite: false },
		});
	const hidden = all.items.find(
		(i: { category: string }) => i.category === "Other",
	);
	expect(
		(
			await viewer.put(`/api/catalog/${hidden.id}/favorite`, {
				data: { favorite: true },
			})
		).ok(),
	).toBe(true);
	const data = {
		revision: config.revision,
		sourceRevision: config.sourceRevision,
		visibility: { tv: ["News"], movie: [], series: [] },
	};
	expect((await viewer.put(endpoint, { data })).status()).toBe(403);
	expect((await owner.put(endpoint, { data })).ok()).toBe(true);
	expect((await owner.put(endpoint, { data })).status()).toBe(409);
	expect((await viewer.put(orderEndpoint, { data: orderData })).status()).toBe(
		404,
	);
	const visible = await (await viewer.get("/api/catalog?kind=tv")).json();
	expect(visible.total).toBe(1);
	expect(visible.categories).toEqual(["News"]);
	for (const suffix of ["&category=Other", "&q=Hidden", "&favorites=1"])
		expect(
			(await (await viewer.get(`/api/catalog?kind=tv${suffix}`)).json()).total,
		).toBe(0);
	expect(
		(
			await viewer.post("/api/playback", { data: { itemId: hidden.id } })
		).status(),
	).toBe(404);
	expect((await viewer.get(`/api/catalog/${hidden.id}/details`)).status()).toBe(
		404,
	);
	expect((await viewer.get(`/api/catalog/${hidden.id}/art`)).status()).toBe(
		404,
	);
	expect(
		(
			await owner.put(endpoint, {
				data: {
					...data,
					revision: config.revision + 1,
					visibility: { tv: [], movie: [], series: [] },
				},
			})
		).ok(),
	).toBe(true);
	expect((await (await viewer.get("/api/catalog?kind=tv")).json()).total).toBe(
		0,
	);
	expect(
		(
			await owner.put(endpoint, {
				data: {
					...data,
					revision: config.revision + 2,
					visibility: { tv: null, movie: null, series: null },
				},
			})
		).ok(),
	).toBe(true);
	expect((await (await viewer.get("/api/catalog?kind=tv")).json()).total).toBe(
		2,
	);
}
