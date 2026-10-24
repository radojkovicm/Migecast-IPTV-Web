import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve("demo/dist");
const mime = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
};
const headers = (await readFile("demo/_headers", "utf8"))
	.split("\n")
	.slice(1)
	.filter((x) => x.trim())
	.map((x) => {
		const i = x.indexOf(":");
		return [x.slice(0, i).trim(), x.slice(i + 1).trim()];
	});
const server = createServer(async (req, res) => {
	const path = resolve(
		root,
		`.${req.url === "/" ? "/index.html" : req.url.split("?")[0]}`,
	);
	if (!path.startsWith(root + sep)) {
		res.writeHead(403).end();
		return;
	}
	try {
		const bytes = await readFile(path);
		res.writeHead(200, {
			"Content-Type": mime[extname(path)] || "application/octet-stream",
			...Object.fromEntries(headers),
		});
		res.end(bytes);
	} catch {
		res.writeHead(404).end();
	}
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true });
try {
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	if (process.env.LIVE_DEMO) {
		page.on("console", (m) => {
			if (m.type() === "error") console.log("Browser:", m.text().slice(0, 300));
		});
		page.on("response", (r) => {
			if (r.status() >= 400)
				console.log("HTTP", r.status(), new URL(r.url()).hostname);
		});
	}
	await page.goto(`http://127.0.0.1:${server.address().port}`);
	await page.locator(".select").first().waitFor();

	const catalog = JSON.parse(
		await readFile("demo/channels.json", "utf8"),
	).channels;
	assert.ok(catalog.length > 1000);
	assert.equal(
		await page.locator("#country option").count(),
		new Set(catalog.map((c) => c.country)).size + 1,
	);
	assert.equal(await page.locator(".select").count(), 80);
	await page.locator("#channels").evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	await page.waitForFunction(
		() => document.querySelectorAll(".select").length > 80,
	);
	await page.getByLabel("Država", { exact: true }).selectOption("Serbia");
	assert.equal(
		await page.locator(".select").count(),
		catalog.filter((c) => c.country === "Serbia").length,
	);
	await page.getByLabel("Pronađi kanal").fill("Kurir");
	await page
		.getByRole("button", { name: "Omiljeno: Kurir TV", exact: true })
		.click();
	await page.reload();
	await page.getByRole("button", { name: "★ Omiljeno", exact: true }).click();
	assert.equal(await page.locator(".select").count(), 1);
	await page.getByRole("button", { name: "Svi kanali", exact: true }).click();
	const external = catalog.find((c) => c.kind === "website");
	await page
		.getByLabel("Država", { exact: true })
		.selectOption(external.country);
	await page.getByLabel("Pronađi kanal").fill(external.name);
	await page.locator(`[data-channel-id="${external.id}"]`).click();
	assert.equal(
		await page.locator("#source-link").getAttribute("href"),
		external.url,
	);
	assert.equal(await page.locator("video").getAttribute("src"), null);
	await page.getByLabel("Samo izvori za browser").check();
	assert.equal(
		await page.locator(`[data-channel-id="${external.id}"]`).count(),
		0,
	);
	await page.getByLabel("Samo izvori za browser").uncheck();
	await page.getByLabel("Država", { exact: true }).selectOption("Serbia");
	await page.getByLabel("Pronađi kanal").fill("Kurir");
	await page
		.getByRole("button", { name: "Povećaj plejer", exact: true })
		.click();
	await page.waitForFunction(
		() =>
			document.fullscreenElement ||
			document.querySelector("#player").classList.contains("expanded"),
	);
	await page
		.getByRole("button", { name: "Smanji ekran", exact: true })
		.last()
		.click();
	await page.waitForFunction(
		() =>
			!document.fullscreenElement &&
			!document.querySelector("#player").classList.contains("expanded"),
	);
	await page.setViewportSize({ width: 390, height: 844 });
	assert.equal(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
		true,
	);
	const box = await page.locator(".favorite").first().boundingBox();
	assert.ok(box.width >= 44 && box.height >= 44);
	if (process.env.DEMO_SCREENSHOT)
		await page.screenshot({
			path: process.env.DEMO_SCREENSHOT,
			fullPage: true,
		});
	if (process.env.LIVE_DEMO === "1") {
		for (const name of ["Kurir TV", "DELUXE MUSIC", "Tagesschau24"]) {
			await page.getByLabel("Država", { exact: true }).selectOption("");
			await page.getByLabel("Pronađi kanal").fill(name);
			await page
				.locator(".select")
				.filter({
					has: page.locator("span", { hasText: new RegExp(`^${name}$`, "i") }),
				})
				.first()
				.click();
			await page.waitForFunction(
				() => {
					const v = document.querySelector("video");
					return v.currentTime > 3 && v.readyState >= 2 && !v.paused;
				},
				null,
				{ timeout: 35000 },
			);
			console.log(`Live playback decoded: ${name}`);
		}
	} else {
		await page.route("https://static.am.mediaoutcast.com/**", (r) =>
			r.fulfill({
				status: 404,
				headers: { "Access-Control-Allow-Origin": "*" },
				body: "",
			}),
		);
		await page.locator(".select").first().click();
		await page
			.getByRole("status")
			.filter({ hasText: "Kanal trenutno nije dostupan" })
			.waitFor({ timeout: 30000 });
	}
	assert.deepEqual(errors, []);
	console.log(
		"PASS: country catalog, progressive scrolling, unsupported-source link, browser filter, favorites, search, fullscreen, mobile layout, playback/error handling.",
	);
} finally {
	await browser.close();
	await new Promise((r) => server.close(r));
}
