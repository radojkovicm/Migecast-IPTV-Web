import { expect, type Page } from "@playwright/test";

// Call with an actively playing worker VOD fixture, before the idle-controls check.
export async function checkPlayerGestures(page: Page) {
	const video = page.getByLabel("Video", { exact: true });
	await expect(video).toHaveCSS("object-fit", "cover");
	await page.getByRole("button", { name: "Cela slika", exact: true }).click();
	await expect(video).toHaveCSS("object-fit", "contain");
	await page.getByRole("button", { name: "Popuni ekran", exact: true }).click();
	await expect(video).toHaveCSS("object-fit", "cover");

	await video.click();
	await expect
		.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused))
		.toBe(true);
	await video.click();
	await expect
		.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused))
		.toBe(false);

	const fullscreen = () =>
		video.evaluate((node) => !!document.fullscreenElement?.contains(node));
	const initiallyFullscreen = await fullscreen();
	await video.dblclick();
	await expect.poll(fullscreen).toBe(!initiallyFullscreen);
	// Wait past the single-click delay: fullscreen must not leave a delayed pause.
	await page.waitForTimeout(650);
	await expect
		.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused))
		.toBe(false);
	await video.dblclick();
	await expect.poll(fullscreen).toBe(initiallyFullscreen);
	await page.waitForTimeout(650);
	await expect
		.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused))
		.toBe(false);

	await video.focus();
	await video.press("Enter");
	await expect
		.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused))
		.toBe(true);
	await video.press("Enter");
	await expect
		.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused))
		.toBe(false);
}
