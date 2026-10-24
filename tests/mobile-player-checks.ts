import { expect, type Page } from "@playwright/test";

// Reuse the disposable catalog, but do not acquire a second provider lease.
export async function checkMobilePlayer(page: Page) {
	const browser = page.context().browser();
	if (!browser) throw new Error("Mobile player check requires a browser");
	const context = await browser.newContext({
		storageState: await page.context().storageState(),
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
	});
	try {
		await context.route("**/api/playback", (route) =>
			route.fulfill({ status: 503, json: { error: "Test controls only" } }),
		);
		const mobile = await context.newPage();
		await mobile.goto(new URL("/gledaj/tv", page.url()).toString());
		await mobile
			.getByRole("combobox", { name: "Kategorija", exact: true })
			.selectOption("");
		await mobile
			.getByRole("button", { name: "HLS playback", exact: true })
			.tap();
		const player = mobile.getByRole("region", { name: "Plejer", exact: true });
		await expect(player).toBeVisible();
		await player.getByRole("button", { name: "Ceo ekran", exact: true }).tap();
		await expect(player).toHaveClass(/landscape-player/);
		const canvas = player.locator(".player-canvas");
		await expect
			.poll(() =>
				canvas.evaluate((node) => node.clientWidth > node.clientHeight),
			)
			.toBe(true);
		await expect
			.poll(() =>
				canvas.evaluate((node) => {
					const matrix = new DOMMatrix(getComputedStyle(node).transform);
					return [matrix.a, matrix.b, matrix.c, matrix.d];
				}),
			)
			.toEqual([0, 1, -1, 0]);
		await player
			.getByRole("button", { name: "Smanji plejer", exact: true })
			.tap();
		await expect(player).not.toHaveClass(/landscape-player/);
		// iPhone-like absence of Fullscreen API must retain touch-accessible controls.
		await mobile.evaluate(() =>
			Object.defineProperty(document, "fullscreenEnabled", {
				configurable: true,
				value: false,
			}),
		);
		await player.getByRole("button", { name: "Ceo ekran", exact: true }).tap();
		await expect(player).toHaveClass(/viewport-fullscreen/);
		await player
			.getByRole("button", { name: "Podešavanja plejera", exact: true })
			.tap();
		await expect(
			player.getByRole("region", { name: "Podešavanja reprodukcije" }),
		).toBeVisible();
		await expect(
			player.getByRole("button", { name: "Kompatibilni režim" }),
		).toHaveCount(0);
		await player
			.getByRole("button", { name: "Podešavanja plejera", exact: true })
			.tap();
		await player
			.getByRole("button", { name: "Vrati prikaz", exact: true })
			.tap();
		await expect(player).not.toHaveClass(/viewport-fullscreen/);
		await expect
			.poll(() => mobile.evaluate(() => document.body.style.overflow))
			.not.toBe("hidden");
		await player
			.getByRole("button", { name: "Zatvori plejer", exact: true })
			.tap();
		await expect(player).toHaveCount(0);
	} finally {
		await context.close();
	}
}
