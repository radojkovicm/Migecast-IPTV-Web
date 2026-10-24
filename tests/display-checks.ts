import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { Client } from "pg";

export async function checkDisplay(
	page: Page,
	viewer: APIRequestContext,
	userId: string,
) {
	await expect(
		page.getByRole("button", { name: "Odjavi se", exact: true }),
	).toHaveCount(0);
	await page.getByRole("button", { name: "Ceo ekran", exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() => document.fullscreenElement === document.documentElement,
			),
		)
		.toBe(true);
	await expect(
		page.getByRole("button", { name: "Smanji ekran", exact: true }),
	).toBeVisible();
	await page.mouse.wheel(0, 1000);
	await expect(
		page.getByRole("button", { name: "Smanji ekran", exact: true }),
	).toBeInViewport();
	await page.getByRole("button", { name: "Smanji ekran", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => document.fullscreenElement === null))
		.toBe(true);
	// Age only this disposable fixture's API session, without waiting a day.
	const session = (await (await viewer.get("/api/auth/get-session")).json())
		.session;
	const db = new Client({ connectionString: process.env.DATABASE_URL });
	await db.connect();
	try {
		await db.query(
			'UPDATE session SET "expiresAt" = NOW() + INTERVAL \'2 days\', "updatedAt" = NOW() - INTERVAL \'2 days\' WHERE id = $1 AND "userId" = $2',
			[session.id, userId],
		);
		// Domain authorization must not consume renewal without returning its cookie.
		await viewer.get("/api/catalog?kind=tv");
		const unchanged = await db.query(
			'SELECT "expiresAt" FROM session WHERE id = $1',
			[session.id],
		);
		expect(
			new Date(unchanged.rows[0].expiresAt).getTime() - Date.now(),
		).toBeLessThan(3 * 86400000);
		const response = await viewer.get("/api/auth/get-session");
		const refreshed = (await response.json()).session;
		expect(
			new Date(refreshed.expiresAt).getTime() - Date.now(),
		).toBeGreaterThan(29 * 86400000);
		expect(response.headers()["set-cookie"]).toContain("Max-Age=");
	} finally {
		await db.end();
	}
}
