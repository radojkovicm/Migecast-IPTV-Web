import { chromium, expect, type Page, webkit } from "@playwright/test";

// Opt-in engines are never substituted silently. WebKit is not a Safari acceptance claim.
export async function checkAdditionalBrowsers(page: Page) {
	for (const name of (process.env.TEST_EXTRA_BROWSERS ?? "")
		.split(",")
		.filter(Boolean)) {
		if (!["edge", "brave", "webkit"].includes(name))
			throw new Error("Unknown test browser");
		const braveExecutable =
			process.env.TEST_BRAVE_EXECUTABLE ??
			(process.platform === "darwin"
				? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
				: undefined);
		if (name === "brave" && !braveExecutable)
			throw new Error(
				"Set TEST_BRAVE_EXECUTABLE to the installed Brave binary",
			);
		const browser =
			name === "edge"
				? await chromium.launch({ channel: "msedge", headless: true })
				: name === "brave"
					? await chromium.launch({
							executablePath: braveExecutable,
							headless: true,
						})
					: await webkit.launch({ channel: "", headless: true });
		try {
			const context = await browser.newContext({
				storageState: await page.context().storageState(),
			});
			const target = await context.newPage();
			await target.goto(`${process.env.TEST_BASE_URL}/gledaj/filmovi`);
			await expect(
				target.getByRole("combobox", { name: "Kategorija", exact: true }),
			).toHaveValue("__favorites__");
			await target
				.getByRole("combobox", { name: "Kategorija", exact: true })
				.selectOption("");
			const start = target.waitForResponse(
				(r) =>
					r.url().endsWith("/api/playback") && r.request().method() === "POST",
			);
			await target
				.getByRole("button", { name: "Worker film", exact: true })
				.click();
			await target
				.getByRole("button", { name: /^(Pusti film|Nastavi gledanje)$/ })
				.click();
			const response = await start;
			expect(response.status()).toBe(201);
			const lease = await response.json();
			const video = target.getByLabel("Video", { exact: true });
			await expect
				.poll(
					() => video.evaluate((node: HTMLVideoElement) => node.readyState),
					{ timeout: 25000 },
				)
				.toBeGreaterThanOrEqual(3);
			await video.evaluate((node: HTMLVideoElement) => {
				node.muted = true;
				void node.play();
			});
			await expect
				.poll(() =>
					video.evaluate((node: HTMLVideoElement) => node.currentTime),
				)
				.toBeGreaterThan(0);
			await target
				.getByRole("button", { name: "Zatvori plejer", exact: true })
				.click();
			await expect
				.poll(async () =>
					(
						await context.request.get(
							`${process.env.TEST_BASE_URL}${lease.url}`,
						)
					).status(),
				)
				.toBe(410);
			console.info(
				`${name}: generated MKV/H264+AAC worker playback and close passed.`,
			);
			await context.close();
		} finally {
			await browser.close();
		}
	}
}
