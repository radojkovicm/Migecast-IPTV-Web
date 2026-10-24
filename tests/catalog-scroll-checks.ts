import { expect, type Page } from "@playwright/test";

export async function checkCatalogScroll(page: Page) {
	const requested: number[] = [];
	const pattern = "**/api/catalog?**";
	await page.route(pattern, async (route) => {
		const url = new URL(route.request().url());
		if (url.searchParams.get("kind") !== "movie") return route.continue();
		const filtered = url.searchParams.get("q") === "Filtered";
		const pageNumber = Number(url.searchParams.get("page"));
		requested.push(pageNumber);
		const ids = filtered
			? [999]
			: pageNumber === 0
				? Array.from({ length: 60 }, (_, i) => i)
				: [60];
		await route.fulfill({
			json: {
				ready: true,
				total: filtered ? 1 : 61,
				categories: [],
				items: ids.map((i) => ({
					id: `scroll-fixture-${i}`,
					title: filtered ? "Filtered" : `Poster ${i}`,
					kind: "movie",
					favorite: false,
					position: 0,
					duration: 0,
					completed: false,
				})),
			},
		});
	});
	try {
		await page.goto(`${process.env.TEST_BASE_URL}/gledaj/filmovi`);
		await expect(
			page.getByRole("button", { name: "Poster 0", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Sledeća", exact: true }),
		).toHaveCount(0);
		await page.locator(".catalog-load-more").scrollIntoViewIfNeeded();
		await expect(
			page.getByRole("button", { name: "Poster 60", exact: true }),
		).toBeVisible();
		await expect(page.locator(".catalog-card")).toHaveCount(61);
		expect([...new Set(requested)]).toEqual([0, 1]);
		const placement = await page
			.locator(".catalog-entry")
			.first()
			.evaluate((node) => {
				const image = node.querySelector("img")?.getBoundingClientRect();
				const star = node
					.querySelector(".favorite-star")
					?.getBoundingClientRect();
				return (
					!!image &&
					!!star &&
					star.top >= image.top &&
					star.top < image.top + 80 &&
					star.right <= image.right
				);
			});
		expect(placement).toBe(true);
		await page.getByRole("searchbox").fill("Filtered");
		await expect(page.locator(".catalog-card")).toHaveCount(1);
		await expect(
			page.getByRole("button", { name: "Filtered", exact: true }),
		).toBeVisible();
		expect(requested.at(-1)).toBe(0);
	} finally {
		await page.unroute(pattern);
	}
}

export async function checkTvScroll(page: Page) {
	const pattern = "**/api/catalog?**";
	const requested: number[] = [];
	await page.route(pattern, async (route) => {
		const url = new URL(route.request().url());
		if (url.searchParams.get("kind") !== "tv") return route.continue();
		const pageNumber = Number(url.searchParams.get("page"));
		const favorites = url.searchParams.get("favorites") === "1";
		if (!favorites) requested.push(pageNumber);
		const ids = favorites
			? []
			: pageNumber === 0
				? Array.from({ length: 60 }, (_, i) => i)
				: [60];
		await route.fulfill({
			json: {
				ready: true,
				total: favorites ? 0 : 61,
				categories: ["News"],
				items: ids.map((i) => ({
					id: `tv-scroll-${i}`,
					title: `Channel ${i}`,
					kind: "tv",
					favorite: false,
					category: "News",
				})),
			},
		});
	});
	try {
		await page.goto(`${process.env.TEST_BASE_URL}/gledaj/tv`);
		await expect(
			page.getByRole("combobox", { name: "Kategorija", exact: true }),
		).toHaveValue("__favorites__");
		await expect(page.locator(".channel-row")).toHaveCount(0);
		await page
			.getByRole("combobox", { name: "Kategorija", exact: true })
			.selectOption("");
		await expect(page.locator(".channel-row")).toHaveCount(60);
		await page.locator(".channel-list").evaluate((node) => {
			node.scrollTop = node.scrollHeight;
		});
		await expect(
			page.getByRole("button", { name: "Channel 60", exact: true }),
		).toBeVisible();
		await expect(page.locator(".channel-row")).toHaveCount(61);
		// The initial search debounce must not reset an already appended page.
		await page.waitForTimeout(350);
		await expect(page.locator(".channel-row")).toHaveCount(61);
		await expect(
			page.getByRole("button", { name: "Sledeća", exact: true }),
		).toHaveCount(0);
		expect([...new Set(requested)]).toEqual([0, 1]);
	} finally {
		await page.unroute(pattern);
	}
}
