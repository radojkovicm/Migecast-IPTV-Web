import { type APIRequestContext, expect, type Page } from "@playwright/test";

export async function checkOwnerDiagnostics(
	owner: APIRequestContext,
	viewer: APIRequestContext,
	anonymous: APIRequestContext,
	page: Page,
	userId: string,
) {
	const endpoint = "/api/admin/diagnostics";
	expect((await anonymous.get(endpoint)).status()).toBe(401);
	expect((await viewer.get(endpoint)).status()).toBe(403);
	const response = await owner.get(endpoint);
	expect(response.ok()).toBe(true);
	expect(response.headers()["cache-control"]).toBe("no-store");
	const snapshot = await response.json();
	expect(snapshot.limited).toBe(false);
	const user = snapshot.users.find(
		(user: { id: string }) => user.id === userId,
	);
	expect(user.activeSessions).toBeGreaterThan(0);
	expect(user.assignedLists).toBeGreaterThan(0);
	const list = snapshot.playlists.find(
		(list: { id: string }) => list.id === user.activePlaylistId,
	);
	expect(list.name).toBe("Category visibility fixture");
	expect(list.catalogReady).toBe(true);
	expect(list.sections).toContainEqual({
		kind: "tv",
		items: 2,
		allowedCategories: null,
	});
	const serialized = JSON.stringify(snapshot);
	for (const forbidden of [
		"providerKey",
		"encryptedInput",
		"encryptedLocator",
		"token",
		"password",
		"ipAddress",
		"userAgent",
		"example.invalid",
	])
		expect(serialized).not.toContain(forbidden);

	const browser = page.context().browser();
	if (!browser) throw new Error("Browser context is required");
	const context = await browser.newContext({
		storageState: await owner.storageState(),
		baseURL: process.env.TEST_BASE_URL,
	});
	try {
		const admin = await context.newPage();
		await admin.goto("/admin");
		await expect(
			admin.getByRole("heading", { name: "Pregled korisnika i lista" }),
		).toBeVisible();
		await expect(
			admin.getByRole("button", { name: "Osveži stanje", exact: true }),
		).toBeEnabled();
		await admin.getByLabel("Pronađi korisnika ili listu").fill("viewer");
		const card = admin
			.locator(".diagnostics-card")
			.filter({ hasText: "@viewer" });
		await expect(card).toHaveCount(1);
		await expect(
			card.getByText("Category visibility fixture", { exact: true }),
		).toBeVisible();
		if (process.env.TEST_SCREENSHOT_DIR)
			await admin.screenshot({
				path: `${process.env.TEST_SCREENSHOT_DIR}/owner-diagnostics.png`,
				fullPage: true,
			});
		await card.getByRole("link", { name: "Podesi liste korisnika" }).click();
		await expect(admin).toHaveURL(
			new RegExp(`/admin/liste\\?user=${userId}#assignments$`),
		);
		await expect(admin.locator("#assignments")).toBeVisible();
		await expect(admin.getByLabel("Korisnik", { exact: true })).toHaveValue(
			userId,
		);
	} finally {
		await context.close();
	}
}
