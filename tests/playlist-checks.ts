import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { Client } from "pg";

export async function checkPlaylists(
	owner: APIRequestContext,
	viewer: APIRequestContext,
	anonymous: APIRequestContext,
	viewerId: string,
	page: Page,
) {
	const example = {
		name: "Glavna",
		input: {
			kind: "xtream",
			server: "https://example.invalid",
			username: "provider-user",
			password: "provider-secret",
		},
	};
	expect((await anonymous.get("/api/playlists")).status()).toBe(401);
	expect((await viewer.get("/api/admin/playlists")).status()).toBe(403);
	expect(
		(await viewer.post("/api/admin/playlists", { data: example })).status(),
	).toBe(403);
	expect(
		(
			await owner.post("/api/admin/playlists", {
				headers: { origin: "https://other.invalid" },
				data: example,
			})
		).status(),
	).toBe(403);
	expect(
		(
			await owner.post("/api/admin/playlists", {
				headers: { "Content-Type": "text/plain" },
				data: "{}",
			})
		).status(),
	).toBe(415);
	expect(
		(
			await owner.post("/api/admin/playlists", {
				data: {
					name: "Bad",
					input: { kind: "file", content: "not a playlist" },
				},
			})
		).status(),
	).toBe(400);
	expect(
		(
			await owner.post("/api/admin/playlists", {
				data: "{",
				headers: { "Content-Type": "application/json" },
			})
		).status(),
	).toBe(400);
	expect(
		(
			await owner.post("/api/admin/playlists", {
				data: { ...example, name: "x".repeat(13 * 1024 * 1024) },
			})
		).status(),
	).toBe(413);
	const created = await owner.post("/api/admin/playlists", { data: example });
	expect(created.status()).toBe(201);
	const one = await created.json();
	const savedResponse = JSON.stringify(one);
	for (const secret of [
		"provider-secret",
		"provider-user",
		"example.invalid",
		"encryptedInput",
		"providerKey",
	])
		expect(savedResponse.includes(secret)).toBe(false);
	const two = await (
		await owner.post("/api/admin/playlists", {
			data: {
				name: "Rezervna",
				input: {
					kind: "url",
					url: "https://example.invalid/get.php?username=provider-user&password=provider-secret&type=m3u_plus",
				},
			},
		})
	).json();
	expect(two.kind).toBe("xtream");
	const three = await (
		await owner.post("/api/admin/playlists", {
			data: {
				name: "Fajl",
				input: {
					kind: "file",
					content:
						"#EXTM3U\n#EXTINF:-1,Test\nhttps://example.invalid/live/token.m3u8\n",
				},
			},
		})
	).json();
	expect(three.entryCount).toBe(1);
	const m3u = await (
		await owner.post("/api/admin/playlists", {
			data: {
				name: "M3U link",
				input: {
					kind: "url",
					url: "https://example.invalid/playlist.m3u?token=secret",
				},
			},
		})
	).json();
	expect(m3u.kind).toBe("m3u");
	const snapshot = async () =>
		(await (await owner.get("/api/admin/playlists")).json()).users.find(
			(user: { id: string }) => user.id === viewerId,
		);
	let user = await snapshot();
	expect(await (await viewer.get("/api/playlists")).json()).toEqual({
		playlists: [],
		activePlaylistId: null,
	});
	expect(
		(
			await owner.put(`/api/admin/users/${viewerId}/active-playlist`, {
				data: { playlistId: one.id, revision: user.playlistRevision },
			})
		).status(),
	).toBe(403);
	expect(
		(
			await owner.put(`/api/admin/users/${viewerId}/playlists`, {
				data: {
					playlistIds: [one.id, two.id],
					revision: user.playlistRevision,
				},
			})
		).ok(),
	).toBe(true);
	user = await snapshot();
	let mine = await (await viewer.get("/api/playlists")).json();
	expect(mine.playlists.map((list: { id: string }) => list.id).sort()).toEqual(
		[one.id, two.id].sort(),
	);
	expect(mine.activePlaylistId).toBeNull();
	expect(
		(
			await viewer.put(`/api/admin/users/${viewerId}/active-playlist`, {
				data: { playlistId: one.id, revision: user.playlistRevision },
			})
		).status(),
	).toBe(403);
	expect(
		(
			await owner.put(`/api/admin/users/${viewerId}/active-playlist`, {
				data: { playlistId: one.id, revision: user.playlistRevision },
			})
		).ok(),
	).toBe(true);
	expect(
		(
			await owner.put(`/api/admin/users/${viewerId}/active-playlist`, {
				data: { playlistId: two.id, revision: user.playlistRevision },
			})
		).status(),
	).toBe(409);
	user = await snapshot();
	expect(
		(
			await owner.put(`/api/admin/users/${viewerId}/playlists`, {
				data: { playlistIds: [two.id], revision: user.playlistRevision },
			})
		).status(),
	).toBe(409);
	expect(
		(
			await owner.delete(`/api/admin/playlists/${one.id}`, {
				data: { revision: one.revision },
			})
		).status(),
	).toBe(409);
	expect(
		(
			await owner.patch(`/api/admin/playlists/${one.id}`, {
				data: {
					revision: one.revision,
					name: "Broken",
					input: { kind: "file", content: "bad" },
				},
			})
		).status(),
	).toBe(400);
	mine = await (await viewer.get("/api/playlists")).json();
	expect(mine.activePlaylistId).toBe(one.id);
	expect(
		mine.playlists.find((list: { id: string }) => list.id === one.id).name,
	).toBe("Glavna");
	const renamed = await owner.patch(`/api/admin/playlists/${one.id}`, {
		data: { revision: one.revision, name: "Glavna nova" },
	});
	expect(renamed.ok()).toBe(true);
	const renamedSource = await renamed.json();
	expect(
		(
			await owner.patch(`/api/admin/playlists/${one.id}`, {
				data: { revision: one.revision, name: "Stale" },
			})
		).status(),
	).toBe(409);
	// Two simultaneous selections cannot both consume the same revision.
	const race = await Promise.all(
		[one.id, two.id].map((playlistId) =>
			owner.put(`/api/admin/users/${viewerId}/active-playlist`, {
				data: { playlistId, revision: user.playlistRevision },
			}),
		),
	);
	expect(race.map((response) => response.status()).sort()).toEqual([200, 409]);
	user = await snapshot();
	const current = user.playlistSelection.playlistId;
	expect([one.id, two.id]).toContain(current);
	// Database storage contains only encrypted source inputs and a keyed identity.
	const db = new Client({ connectionString: process.env.DATABASE_URL });
	await db.connect();
	try {
		const rows = (
			await db.query(
				'SELECT "id", "encryptedInput", "providerKey" FROM "playlist" ORDER BY "id"',
			)
		).rows;
		const serialized = JSON.stringify(rows);
		for (const secret of [
			"provider-secret",
			"provider-user",
			"example.invalid",
			"token.m3u8",
		])
			expect(serialized.includes(secret)).toBe(false);
		expect(rows.find((row) => row.id === one.id).providerKey).toBe(
			rows.find((row) => row.id === two.id).providerKey,
		);
		// The FK independently prevents selecting an unassigned source.
		await expect(
			db.query(
				'UPDATE "playlistSelection" SET "playlistId" = $1 WHERE "userId" = $2',
				[three.id, viewerId],
			),
		).rejects.toMatchObject({ code: "23503" });
	} finally {
		await db.end();
	}
	// A viewer cannot request another user's inventory by changing the query string.
	expect(
		(await (await viewer.get(`/api/playlists?userId=someone-else`)).json())
			.activePlaylistId,
	).toBe(current);
	// Owner-only web UI: create, rename, assign and activate a file through the form.
	const ownerState = await owner.storageState();
	const browser = page.context().browser();
	if (!browser) throw new Error("Browser required");
	const adminContext = await browser.newContext({
		baseURL: process.env.TEST_BASE_URL,
		storageState: ownerState,
	});
	try {
		const adminPage = await adminContext.newPage();
		await adminPage.goto("/admin/liste");
		await adminPage
			.getByLabel("Naziv liste", { exact: true })
			.fill("Browser fajl");
		await adminPage.getByRole("radio", { name: "Fajl", exact: true }).check();
		await adminPage.getByLabel("M3U/M3U8 fajl (do 10 MiB)").setInputFiles({
			name: "example.m3u",
			mimeType: "audio/x-mpegurl",
			buffer: Buffer.from(
				"#EXTM3U\n#EXTINF:-1,Test\nhttps://example.invalid/test.ts\n",
			),
		});
		await adminPage
			.getByRole("button", { name: "Sačuvaj listu", exact: true })
			.click();
		await expect(
			adminPage.getByText(
				"Lista je sačuvana i katalog je učitan. Dodelite je korisniku, pa izaberite Koristi.",
			),
		).toBeVisible();
		const savedList = adminPage
			.getByRole("listitem")
			.filter({
				has: adminPage.getByText("Browser fajl", { exact: true }),
			})
			.filter({
				has: adminPage.getByRole("button", { name: "Uredi", exact: true }),
			});
		await expect(savedList).toContainText("Katalog učitan · 1 stavki");
		await savedList.getByRole("button", { name: "Uredi", exact: true }).click();
		await adminPage
			.getByLabel("Naziv liste", { exact: true })
			.fill("Browser fajl renamed");
		await adminPage
			.getByRole("button", { name: "Sačuvaj listu", exact: true })
			.click();
		await expect(
			adminPage.getByText("Lista je sačuvana.", { exact: true }),
		).toBeVisible();
		await expect(
			adminPage
				.getByRole("listitem")
				.filter({
					has: adminPage.getByText("Browser fajl renamed", { exact: true }),
				})
				.filter({
					has: adminPage.getByRole("button", { name: "Uredi", exact: true }),
				}),
		).toContainText("Katalog učitan · 1 stavki");
		// A failed catalog import keeps the saved source and offers a refresh, not another create.
		const renamedList = adminPage
			.getByRole("listitem")
			.filter({
				has: adminPage.getByText("Browser fajl renamed", { exact: true }),
			})
			.filter({
				has: adminPage.getByRole("button", { name: "Uredi", exact: true }),
			});
		await renamedList
			.getByRole("button", { name: "Uredi", exact: true })
			.click();
		await adminPage.getByLabel("Promeni link, fajl ili Xtream podatke").check();
		await adminPage.getByLabel("M3U/M3U8 fajl (do 10 MiB)").setInputFiles({
			name: "replacement.m3u",
			mimeType: "audio/x-mpegurl",
			buffer: Buffer.from(
				"#EXTM3U\n#EXTINF:-1,Replacement\nhttps://example.invalid/replacement.ts\n",
			),
		});
		await adminPage.route(
			"**/api/admin/playlists/*/refresh",
			(route) =>
				route.fulfill({
					status: 502,
					contentType: "application/json",
					body: JSON.stringify({ error: "Test import failure" }),
				}),
			{ times: 1 },
		);
		await adminPage
			.getByRole("button", { name: "Sačuvaj listu", exact: true })
			.click();
		await expect(
			adminPage.locator(".playlist-manager").getByRole("alert"),
		).toContainText("Lista je sačuvana, ali katalog nije učitan.");
		await expect(renamedList).toHaveCount(1);
		await expect(renamedList).toContainText(
			"Izvor je promenjen — osvežite katalog.",
		);
		await expect(
			adminPage.getByLabel("Naziv liste", { exact: true }),
		).toHaveValue("");
		await renamedList
			.getByRole("button", { name: "Osveži katalog", exact: true })
			.click();
		await expect(
			adminPage.getByText("Katalog je učitan.", { exact: true }),
		).toBeVisible();
		await expect(renamedList).toContainText("Katalog učitan · 1 stavki");
		await adminPage
			.getByRole("checkbox", { name: "Browser fajl renamed", exact: true })
			.check();
		await adminPage.getByRole("button", { name: "Sačuvaj dodelu" }).click();
		await expect(adminPage.getByText("Dodela je sačuvana.")).toBeVisible();
		await adminPage
			.getByRole("listitem")
			.filter({
				has: adminPage.getByRole("checkbox", {
					name: "Browser fajl renamed",
					exact: true,
				}),
			})
			.getByRole("button", { name: "Koristi" })
			.click();
		await expect(
			adminPage.getByText("Aktivna lista je promenjena."),
		).toBeVisible();
		if (process.env.TEST_SCREENSHOT_DIR)
			await adminPage.screenshot({
				path: `${process.env.TEST_SCREENSHOT_DIR}/playlists.png`,
				fullPage: true,
			});
		await adminPage.goto("/");
		await expect(
			adminPage.getByText("Aktivna lista: Browser fajl renamed"),
		).toBeVisible();
		if (process.env.TEST_SCREENSHOT_DIR)
			await adminPage.screenshot({
				path: `${process.env.TEST_SCREENSHOT_DIR}/home-owner.png`,
				fullPage: true,
			});
	} finally {
		await adminContext.close();
	}
	const revision = current === one.id ? renamedSource.revision : two.revision;
	expect(
		(
			await owner.delete(`/api/admin/playlists/${current}`, {
				data: { revision, detach: true },
			})
		).ok(),
	).toBe(true);
	mine = await (await viewer.get("/api/playlists")).json();
	expect(mine.activePlaylistId).toBeNull();
	expect(
		mine.playlists.some((list: { id: string }) => list.id === current),
	).toBe(false);
	// Explicitly removing the active source clears selection and leaves no dangling FK.
	user = await snapshot();
	const remaining = mine.playlists[0].id;
	expect(
		(
			await owner.put(`/api/admin/users/${viewerId}/active-playlist`, {
				data: { playlistId: remaining, revision: user.playlistRevision },
			})
		).ok(),
	).toBe(true);
	user = await snapshot();
	expect(
		(
			await owner.put(`/api/admin/users/${viewerId}/playlists`, {
				data: {
					playlistIds: [],
					revision: user.playlistRevision,
					deactivate: true,
				},
			})
		).ok(),
	).toBe(true);
	expect(await (await viewer.get("/api/playlists")).json()).toEqual({
		playlists: [],
		activePlaylistId: null,
	});
}
