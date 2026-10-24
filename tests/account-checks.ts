import { type APIRequestContext, expect, type Page } from "@playwright/test";

export async function checkAccounts(
	owner: APIRequestContext,
	viewer: APIRequestContext,
	anonymous: APIRequestContext,
	viewerId: string,
	viewerPassword: string,
	page: Page,
) {
	const baseURL = process.env.TEST_BASE_URL;
	const replacement = `${viewerPassword}-changed`;
	for (const client of [anonymous, viewer]) {
		for (const path of [
			"ban-user",
			"unban-user",
			"revoke-user-sessions",
			"set-user-password",
		]) {
			expect(
				(
					await client.post(`/api/auth/admin/${path}`, {
						data: { userId: viewerId, newPassword: replacement },
					})
				).status(),
			).toBe(403);
		}
	}
	expect(
		(
			await owner.post("/api/auth/admin/set-user-password", {
				data: { userId: viewerId, newPassword: "short" },
			})
		).ok(),
	).toBe(false);
	expect(
		await (await viewer.get("/api/auth/get-session")).json(),
	).not.toBeNull();
	expect(
		(
			await owner.post("/api/auth/admin/set-user-password", {
				headers: { origin: "https://untrusted.example" },
				data: { userId: viewerId, newPassword: replacement },
			})
		).ok(),
	).toBe(false);
	const ownerBrowser = await page
		.context()
		.browser()
		?.newContext({ baseURL, storageState: await owner.storageState() });
	if (!ownerBrowser) throw new Error("Browser context required");
	try {
		const admin = await ownerBrowser.newPage();
		admin.on("dialog", (dialog) => dialog.accept());
		await admin.goto("/admin");
		const controls = admin.getByRole("group", {
			name: "Nalog: Test Viewer",
			exact: true,
		});
		await controls
			.getByRole("button", { name: "Prekini prijave", exact: true })
			.click();
		await expect(controls.getByRole("status")).toHaveText(
			"Sve prijave su prekinute.",
		);
		expect(await (await viewer.get("/api/auth/get-session")).json()).toBeNull();
		expect(
			(
				await viewer.post("/api/auth/sign-in/username", {
					data: { username: "viewer", password: viewerPassword },
				})
			).ok(),
		).toBe(true);
		await controls
			.getByRole("button", { name: "Blokiraj", exact: true })
			.click();
		await expect(
			controls.getByRole("button", { name: "Odblokiraj", exact: true }),
		).toBeVisible();
		expect(await (await viewer.get("/api/auth/get-session")).json()).toBeNull();
		expect(
			(
				await viewer.post("/api/auth/sign-in/username", {
					data: { username: "viewer", password: viewerPassword },
				})
			).ok(),
		).toBe(false);
		await controls
			.getByRole("button", { name: "Odblokiraj", exact: true })
			.click();
		await expect(
			controls.getByRole("button", { name: "Blokiraj", exact: true }),
		).toBeVisible();
		expect(
			(
				await viewer.post("/api/auth/sign-in/username", {
					data: { username: "viewer", password: viewerPassword },
				})
			).ok(),
		).toBe(true);
		await controls
			.getByRole("button", { name: "Promeni lozinku", exact: true })
			.click();
		await controls
			.getByLabel("Nova lozinka (najmanje 12 znakova)", { exact: true })
			.fill(replacement);
		await controls
			.getByLabel("Potvrdi novu lozinku", { exact: true })
			.fill(`${replacement}-mismatch`);
		await controls
			.getByRole("button", { name: "Sačuvaj lozinku", exact: true })
			.click();
		await expect(controls.getByRole("alert")).toHaveText(
			"Lozinke se ne podudaraju.",
		);
		await controls
			.getByLabel("Potvrdi novu lozinku", { exact: true })
			.fill(replacement);
		await controls
			.getByRole("button", { name: "Sačuvaj lozinku", exact: true })
			.click();
		await expect(controls.getByRole("status")).toHaveText(
			"Lozinka je promenjena. Sve prijave su prekinute.",
		);
		expect(await (await viewer.get("/api/auth/get-session")).json()).toBeNull();
		expect(
			(
				await viewer.post("/api/auth/sign-in/username", {
					data: { username: "viewer", password: viewerPassword },
				})
			).ok(),
		).toBe(false);
		expect(
			(
				await viewer.post("/api/auth/sign-in/username", {
					data: { username: "viewer", password: replacement },
				})
			).ok(),
		).toBe(true);
		// Restore fixture credentials and prove direct API resets also revoke sessions.
		expect(
			(
				await owner.post("/api/auth/admin/set-user-password", {
					data: { userId: viewerId, newPassword: viewerPassword },
				})
			).ok(),
		).toBe(true);
		expect(await (await viewer.get("/api/auth/get-session")).json()).toBeNull();
	} finally {
		await ownerBrowser.close();
	}
}
