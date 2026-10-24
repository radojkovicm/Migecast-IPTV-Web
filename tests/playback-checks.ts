import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { checkAdditionalBrowsers } from "./browser-playback-checks";
import { checkCatalogScroll, checkTvScroll } from "./catalog-scroll-checks";
import { checkMobilePlayer } from "./mobile-player-checks";
import { checkPlayerGestures } from "./player-gesture-checks";
import { checkSubtitleControls, serveTrackFixture } from "./track-checks";
import { checkViewing } from "./viewing-checks";

async function checkFavoriteCategory(page: Page, title: string) {
	const add = page.getByRole("button", {
		name: `Dodaj u omiljene: ${title}`,
		exact: true,
	});
	await add.click();
	const marked = page.getByRole("button", {
		name: `Ukloni iz omiljenih: ${title}`,
		exact: true,
	});
	await expect(marked).toHaveAttribute("aria-pressed", "true");
	await expect(marked).toHaveText("★");
	await expect(marked).toHaveCSS("color", "rgb(255, 212, 71)");
	await expect(
		page.getByRole("checkbox", { name: "Samo omiljeni", exact: true }),
	).toHaveCount(0);
	const category = page.getByRole("combobox", {
		name: "Kategorija",
		exact: true,
	});
	const filtered = page.waitForResponse(
		(response) =>
			response.url().includes("/api/catalog?") &&
			new URL(response.url()).searchParams.get("favorites") === "1",
	);
	await category.selectOption("__favorites__");
	expect((await filtered).ok()).toBe(true);
	await expect(
		page.getByRole("button", { name: title, exact: true }),
	).toBeVisible();
	const allItems = page.waitForResponse(
		(response) =>
			response.url().includes("/api/catalog?") &&
			new URL(response.url()).searchParams.get("favorites") === "0",
	);
	await category.selectOption("");
	expect((await allItems).ok()).toBe(true);
	await expect(marked).toBeEnabled();
	await marked.click();
	await expect(add).toHaveAttribute("aria-pressed", "false");
}

async function captureDetails(page: Page, name: string) {
	if (!process.env.TEST_SCREENSHOT_DIR) return;
	const viewport = page.viewportSize();
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.screenshot({
		path: `${process.env.TEST_SCREENSHOT_DIR}/${name}.png`,
		fullPage: false,
	});
	if (viewport) await page.setViewportSize(viewport);
}

export async function checkPlayback(
	owner: APIRequestContext,
	viewer: APIRequestContext,
	anonymous: APIRequestContext,
	viewerId: string,
	page: Page,
) {
	const origin = process.env.MEDIA_TEST_ORIGIN;
	if (!origin) throw new Error("Fixture origin missing");
	let failed = false;
	let hits = 0;
	let fragmentFailuresRemaining = 0;
	let fragmentAttempts = 0;
	// Generate our own video fixture in Chromium; no copyrighted external media.

	const encoded = await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 160;
		canvas.height = 90;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Canvas unavailable");
		const stream = canvas.captureStream(15);
		const recorders = [
			"video/webm;codecs=vp8",
			"video/mp4;codecs=avc1.42001E",
		].map((mimeType) => new MediaRecorder(stream, { mimeType }));
		const complete = recorders.map(
			(recorder) =>
				new Promise<string>((resolve) => {
					const chunks: BlobPart[] = [];
					recorder.ondataavailable = (e) => chunks.push(e.data);
					recorder.onstop = async () => {
						const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
						resolve(btoa(String.fromCharCode(...bytes)));
					};
					recorder.start();
				}),
		);
		let frame = 0;
		const timer = setInterval(() => {
			ctx.fillStyle = frame % 2 ? "#4178bb" : "#234567";
			ctx.fillRect(0, 0, 160, 90);
			ctx.fillStyle = "white";
			ctx.fillText("Migecast test", 20, 45);
			if (++frame === 30) {
				clearInterval(timer);
				for (const recorder of recorders) recorder.stop();
			}
		}, 70);
		const result = await Promise.all(complete);
		for (const track of stream.getTracks()) track.stop();
		return result;
	});
	const movie = Buffer.from(encoded[0], "base64");
	const mp4 = Buffer.from(encoded[1], "base64");
	let split = 0;
	while (split < mp4.length) {
		const size = mp4.readUInt32BE(split);
		if (mp4.toString("ascii", split + 4, split + 8) === "moof") break;
		if (size < 8) throw new Error("Invalid fixture MP4");
		split += size;
	}
	if (!split || split >= mp4.length)
		throw new Error("MP4 fixture is not fragmented");
	const init = mp4.subarray(0, split);
	const segment = mp4.subarray(split);

	const workerDir = await mkdtemp(join(tmpdir(), "migecast-browser-worker-"));
	await writeFile(
		join(workerDir, "captions.srt"),
		Array.from(
			{ length: 30 },
			(_, second) =>
				`${second + 1}\n00:00:${String(second).padStart(2, "0")},000 --> 00:00:${String(second + 1).padStart(2, "0")},000\nWorker subtitle\n`,
		).join("\n"),
	);
	const generated = spawnSync(
		process.env.FFMPEG_PATH ?? "ffmpeg",
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=320x180:rate=25",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:sample_rate=48000",
			"-i",
			join(workerDir, "captions.srt"),
			"-map",
			"0:v",
			"-map",
			"1:a",
			"-map",
			"2:s",
			"-c:s",
			"srt",
			"-metadata:s:s:0",
			"language=sr",
			"-t",
			"30",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-g",
			"25",
			"-c:a",
			"ac3",
			join(workerDir, "worker.mkv"),
		],
		{ timeout: 20000, stdio: "pipe" },
	);
	expect(generated.status).toBe(0);
	const workerMovie = await readFile(join(workerDir, "worker.mkv"));
	const server = createServer((req, res) => {
		hits++;
		const url = new URL(req.url ?? "/", origin);
		if (serveTrackFixture(url.pathname, res)) return;
		if (url.pathname === "/list.m3u") {
			res.setHeader("Content-Type", "audio/x-mpegurl");
			if (failed) {
				res.writeHead(503);
				res.end("Unavailable");
				return;
			}
			res.end(
				`#EXTM3U\n#EXTINF:-1 group-title="Films",Test film\n${origin}/video.webm\n#EXTINF:-1 group-title="TV",Test TV\n${origin}/live.m3u8\n#EXTINF:-1 group-title="TV",HLS playback\n${origin}/play.m3u8\n#EXTINF:-1 group-title="Shows",Test Show S01E01\n${origin}/episode.webm\n#EXTINF:-1 group-title="Shows",Test Show S01E02\n${origin}/episode2.webm\n#EXTINF:-1 group-title="Films",Worker film\n${origin}/worker.mkv`,
			);
			return;
		}

		if (url.pathname === "/play.m3u8") {
			res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
			res.end(
				'#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.1,\nfragment.m4s\n#EXT-X-ENDLIST',
			);
			return;
		}
		if (url.pathname === "/init.mp4" || url.pathname === "/fragment.m4s") {
			if (url.pathname === "/fragment.m4s") {
				fragmentAttempts++;
				if (fragmentFailuresRemaining > 0) {
					fragmentFailuresRemaining--;
					res.writeHead(503);
					res.end("Temporary segment failure");
					return;
				}
			}
			res.setHeader("Content-Type", "video/mp4");
			res.end(url.pathname === "/init.mp4" ? init : segment);
			return;
		}
		if (url.pathname === "/live.m3u8") {
			res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
			res.end(
				'#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-SESSION-DATA:DATA-ID="meta",VALUE="https://provider.invalid/private-token"\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST',
			);
			return;
		}
		if (url.pathname === "/key.bin" || url.pathname === "/segment.ts") {
			res.end(Buffer.alloc(16, 1));
			return;
		}
		if (url.pathname === "/redirect.m3u") {
			res.writeHead(302, { Location: "http://127.0.0.1:1/private" });
			res.end();
			return;
		}
		if (
			url.pathname === "/video.webm" ||
			url.pathname === "/episode.webm" ||
			url.pathname === "/episode2.webm" ||
			url.pathname === "/worker.mkv"
		) {
			const source = url.pathname === "/worker.mkv" ? workerMovie : movie;
			const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
			const start = match ? Number(match[1]) : 0;
			const end = match?.[2]
				? Math.min(Number(match[2]), source.length - 1)
				: source.length - 1;
			res.setHeader("Content-Type", "application/octet-stream");
			res.setHeader("Accept-Ranges", "bytes");
			if (match) {
				res.statusCode = 206;
				res.setHeader(
					"Content-Range",
					`bytes ${start}-${end}/${source.length}`,
				);
			}
			res.setHeader("Content-Length", end - start + 1);
			res.end(source.subarray(start, end + 1));
			return;
		}
		res.writeHead(501);
		res.end();
	});
	await new Promise<void>((resolve) =>
		server.listen(Number(new URL(origin).port), "127.0.0.1", resolve),
	);
	const headers = { "Content-Type": "application/json" };
	async function inventory() {
		return (await owner.get("/api/admin/playlists")).json();
	}
	async function assign(userId: string, playlistId: string) {
		let data = await inventory();
		let user = data.users.find((u: { id: string }) => u.id === userId);
		expect(
			(
				await owner.put(`/api/admin/users/${userId}/playlists`, {
					data: {
						playlistIds: [playlistId],
						revision: user.playlistRevision,
						deactivate: true,
					},
				})
			).ok(),
		).toBe(true);
		data = await inventory();
		user = data.users.find((u: { id: string }) => u.id === userId);
		expect(
			(
				await owner.put(`/api/admin/users/${userId}/active-playlist`, {
					data: { playlistId, revision: user.playlistRevision },
				})
			).ok(),
		).toBe(true);
	}
	try {
		const saved = await owner.post("/api/admin/playlists", {
			data: {
				name: "Playback fixture",
				input: { kind: "url", url: `${origin}/list.m3u` },
			},
		});
		expect(saved.status()).toBe(201);
		const source = await saved.json();
		const refresh = `/api/admin/playlists/${source.id}/refresh`;
		expect(
			(await viewer.post(refresh, { data: { revision: 1 } })).status(),
		).toBe(403);
		expect(
			(await owner.post(refresh, { data: { revision: 1 } })).status(),
		).toBe(200);
		await assign(viewerId, source.id);
		const films = await (await viewer.get("/api/catalog?kind=movie")).json();
		expect(films.items).toHaveLength(2);
		expect(JSON.stringify(films)).not.toContain(origin);
		const tv = await (await viewer.get("/api/catalog?kind=tv")).json();
		const shows = await (await viewer.get("/api/catalog?kind=series")).json();
		expect(shows.items).toHaveLength(1);
		const episodes = await (
			await viewer.get(`/api/catalog/${shows.items[0].id}/episodes`)
		).json();
		expect(episodes.items[0].episode).toBe(1);
		failed = true;
		expect(
			(await owner.post(refresh, { data: { revision: 1 } })).status(),
		).toBe(502);
		expect(
			(await (await viewer.get("/api/catalog?kind=movie")).json()).items[0].id,
		).toBe(films.items[0].id);
		failed = false;
		expect(
			(
				await anonymous.post("/api/playback", {
					data: { itemId: films.items[0].id },
				})
			).status(),
		).toBe(401);
		const started = await viewer.post("/api/playback", {
			data: { itemId: films.items[0].id },
		});
		expect(started.status()).toBe(201);
		const lease = await started.json();
		expect((await anonymous.get(lease.url)).status()).toBe(401);
		expect((await owner.get(lease.url)).status()).toBe(410);
		const range = await viewer.get(lease.url, {
			headers: { Range: "bytes=0-31" },
		});
		expect(range.status()).toBe(206);
		expect(range.headers()["content-type"]).toBe("video/webm");
		expect((await range.body()).length).toBe(32);
		expect((await viewer.get(`${lease.url}tampered`)).status()).toBe(403);
		const state = await inventory();
		const ownerId = state.users.find(
			(u: { username: string }) => u.username === "owner",
		).id;
		await assign(ownerId, source.id);
		await checkViewing(
			owner,
			viewer,
			anonymous,
			films.items[0].id,
			films.items[1].id,
			lease.id,
			source.id,
		);
		expect(
			(
				await owner.post("/api/playback", {
					data: { itemId: films.items[0].id },
				})
			).status(),
		).toBe(409);
		expect(
			(await viewer.patch(`/api/playback/${lease.id}`, { headers })).ok(),
		).toBe(true);
		await viewer.delete(`/api/playback/${lease.id}`, { headers });
		expect((await viewer.get(lease.url)).status()).toBe(410);
		const live = await (
			await viewer.post("/api/playback", {
				data: {
					itemId: tv.items.find(
						(item: { title: string }) => item.title === "Test TV",
					).id,
				},
			})
		).json();
		const manifest = await (await viewer.get(live.url)).text();
		expect(manifest).toContain("#EXTM3U");
		expect(manifest).not.toContain(origin);
		expect(manifest).not.toContain("private-token");
		expect(manifest).not.toContain("key.bin");
		const child = manifest.split("\n").find((line) => line.startsWith("/api/"));
		if (!child) throw new Error("Missing segment URI");
		expect((await viewer.get(child)).status()).toBe(200);
		const key = manifest.match(/URI="([^"]+)"/)?.[1];
		if (!key) throw new Error("Missing key URI");
		expect((await viewer.get(key)).status()).toBe(200);
		expect(
			(
				await viewer.post(`/api/admin/playlists/${source.id}/stop`, {
					data: {},
				})
			).status(),
		).toBe(403);
		expect(
			(
				await owner.post(`/api/admin/playlists/${source.id}/stop`, { data: {} })
			).ok(),
		).toBe(true);
		expect((await viewer.get(live.url)).status()).toBe(410);
		const expiring = await (
			await viewer.post("/api/playback", {
				data: { itemId: films.items[0].id },
			})
		).json();
		const db = new Client({ connectionString: process.env.DATABASE_URL });
		await db.connect();
		try {
			await db.query(
				`UPDATE "playbackLease" SET "expiresAt"=TIMESTAMP '2000-01-01 00:00:00' WHERE id=$1`,
				[expiring.id],
			);
		} finally {
			await db.end();
		}
		expect((await viewer.get(expiring.url)).status()).toBe(410);

		// Real browser decoding and startup timing for generated WebM.
		await checkCatalogScroll(page);
		await checkTvScroll(page);
		await page.goto(`${process.env.TEST_BASE_URL}/gledaj/filmovi`);
		await expect(
			page.getByRole("combobox", { name: "Kategorija", exact: true }),
		).toHaveValue("__favorites__");
		await page
			.getByRole("combobox", { name: "Kategorija", exact: true })
			.selectOption("");
		await checkFavoriteCategory(page, "Test film");
		await page.getByRole("button", { name: "Test film", exact: true }).click();
		const filmDetails = page.getByRole("dialog", {
			name: "Test film",
			exact: true,
		});
		await expect(filmDetails).toBeVisible();
		await expect(
			filmDetails.getByText("Opis nije dostupan u ovoj listi.", {
				exact: true,
			}),
		).toBeVisible();
		await expect(page.getByLabel("Video", { exact: true })).toHaveCount(0);
		await captureDetails(page, "movie-details");
		await page.getByRole("button", { name: "Pusti film", exact: true }).click();
		const video = page.getByLabel("Video", { exact: true });
		await expect(video).toBeVisible();
		await expect(filmDetails).not.toBeVisible();
		const playerDialog = page.getByRole("dialog", {
			name: "Reprodukcija",
			exact: true,
		});
		await expect(playerDialog).toBeVisible();
		await expect
			.poll(() =>
				playerDialog.evaluate((node) => {
					const rect = node.getBoundingClientRect();
					return (
						rect.x === 0 &&
						rect.y === 0 &&
						rect.width >= innerWidth - 1 &&
						rect.height >= innerHeight - 1
					);
				}),
			)
			.toBe(true);
		await expect
			.poll(() =>
				video.evaluate((node) => !!document.fullscreenElement?.contains(node)),
			)
			.toBe(true);
		await expect(
			page.getByRole("button", { name: "Zatvori plejer", exact: true }),
		).toHaveText("");
		await expect(video).toHaveAttribute("src", /api\/playback/, {
			timeout: 10000,
		});
		await expect
			.poll(
				() =>
					video.evaluate((node: HTMLVideoElement) => ({
						state: node.readyState,
						error: node.error?.code ?? 0,
					})),
				{ timeout: 10000 },
			)
			.toMatchObject({ state: 4, error: 0 });
		await video.evaluate((node: HTMLVideoElement) => {
			node.muted = true;
			void node.play();
		});
		await expect
			.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime))
			.toBeGreaterThan(0);
		const startup = await video.getAttribute("data-startup-ms");
		console.info(
			`Generated WebM first-frame startup: ${startup} ms (local fixture, not provider benchmark).`,
		);
		if (process.env.TEST_SCREENSHOT_DIR)
			await page.screenshot({
				path: `${process.env.TEST_SCREENSHOT_DIR}/player.png`,
				fullPage: true,
			});
		await page.getByRole("button", { name: "Zatvori plejer" }).click();
		await expect(video).toHaveCount(0);
		await expect(filmDetails).toBeVisible();
		await expect(playerDialog).not.toBeVisible();
		await expect
			.poll(async () => {
				const db = new Client({ connectionString: process.env.DATABASE_URL });
				await db.connect();
				try {
					return Number(
						(
							await db.query(
								'SELECT count(*) FROM "playbackLease" WHERE "userId"=$1',
								[viewerId],
							)
						).rows[0].count,
					);
				} finally {
					await db.end();
				}
			})
			.toBe(0);

		await page.goto(`${process.env.TEST_BASE_URL}/gledaj/tv`);
		await expect(
			page.getByRole("combobox", { name: "Kategorija", exact: true }),
		).toHaveValue("__favorites__");
		await page
			.getByRole("combobox", { name: "Kategorija", exact: true })
			.selectOption("");
		await checkFavoriteCategory(page, "HLS playback");
		await page
			.getByRole("button", { name: "HLS playback", exact: true })
			.click();
		const hlsVideo = page.getByLabel("Video", { exact: true });
		await expect
			.poll(
				() => hlsVideo.evaluate((node: HTMLVideoElement) => node.readyState),
				{ timeout: 15000 },
			)
			.toBeGreaterThanOrEqual(3);
		await hlsVideo.evaluate((node: HTMLVideoElement) => {
			node.muted = true;
			void node.play();
		});
		await expect
			.poll(() =>
				hlsVideo.evaluate((node: HTMLVideoElement) => node.currentTime),
			)
			.toBeGreaterThan(0);
		console.info(
			`Generated HLS first-frame startup: ${await hlsVideo.getAttribute("data-startup-ms")} ms (local fixture, not provider benchmark).`,
		);
		await expect(
			page.getByRole("button", { name: "HLS playback", exact: true }),
		).toHaveAttribute("aria-pressed", "true");
		await page.getByRole("button", { name: "Pauziraj", exact: true }).click();
		await expect
			.poll(() => hlsVideo.evaluate((node: HTMLVideoElement) => node.paused))
			.toBe(true);
		await page.getByRole("button", { name: "Pusti", exact: true }).click();
		await expect
			.poll(() => hlsVideo.evaluate((node: HTMLVideoElement) => node.paused))
			.toBe(false);
		await page
			.getByRole("button", { name: "Uključi zvuk", exact: true })
			.click();
		await expect
			.poll(() => hlsVideo.evaluate((node: HTMLVideoElement) => node.muted))
			.toBe(false);
		await page
			.getByRole("button", { name: "Isključi zvuk", exact: true })
			.click();
		await page
			.getByRole("button", { name: "HLS playback", exact: true })
			.dblclick();
		await expect
			.poll(() => page.evaluate(() => !!document.fullscreenElement))
			.toBe(true);
		await hlsVideo.dblclick();
		await expect
			.poll(() => page.evaluate(() => document.fullscreenElement === null))
			.toBe(true);
		await hlsVideo.dblclick();
		await expect
			.poll(() => page.evaluate(() => !!document.fullscreenElement))
			.toBe(true);
		await hlsVideo.dblclick();
		await expect
			.poll(() => page.evaluate(() => document.fullscreenElement === null))
			.toBe(true);
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				),
		);
		await page
			.getByRole("banner")
			.getByRole("button", { name: "Ceo ekran", exact: true })
			.click();
		await expect
			.poll(() =>
				page.evaluate(
					() => document.fullscreenElement === document.documentElement,
				),
			)
			.toBe(true);
		await hlsVideo.dblclick();
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						!!document.fullscreenElement &&
						document.fullscreenElement !== document.documentElement,
				),
			)
			.toBe(true);
		await hlsVideo.hover();
		await page
			.getByRole("button", { name: "Smanji plejer", exact: true })
			.click();
		await expect
			.poll(() =>
				page.evaluate(
					() => document.fullscreenElement === document.documentElement,
				),
			)
			.toBe(true);
		await page
			.getByRole("button", { name: "Smanji ekran", exact: true })
			.click();
		await expect
			.poll(() => page.evaluate(() => document.fullscreenElement === null))
			.toBe(true);
		await expect(page.getByRole("banner")).toHaveCount(1);
		const originalViewport = page.viewportSize();
		await page.setViewportSize({ width: 1440, height: 1000 });
		const sidebar = await page
			.getByRole("complementary", { name: "TV kanali" })
			.boundingBox();
		const screen = await page
			.getByRole("region", { name: "Televizija" })
			.boundingBox();
		expect(
			sidebar && screen && sidebar.x + sidebar.width <= screen.x,
		).toBeTruthy();
		if (process.env.TEST_SCREENSHOT_DIR)
			await page.screenshot({
				path: `${process.env.TEST_SCREENSHOT_DIR}/tv-desktop.png`,
				fullPage: true,
			});
		await page.setViewportSize({ width: 390, height: 844 });
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);
		if (process.env.TEST_SCREENSHOT_DIR)
			await page.screenshot({
				path: `${process.env.TEST_SCREENSHOT_DIR}/tv-mobile.png`,
				fullPage: false,
			});
		if (originalViewport) await page.setViewportSize(originalViewport);
		await checkSubtitleControls(page);
		await page.getByRole("button", { name: "Zatvori plejer" }).click();

		// Fail exactly one generated HLS segment, then recover automatically in
		// the same lease. No external source or timing-dependent outage is used.
		fragmentAttempts = 0;
		fragmentFailuresRemaining = 1;
		const recoveryStart = page.waitForResponse(
			(r) =>
				r.url().endsWith("/api/playback") && r.request().method() === "POST",
		);
		const segmentFailure = page.waitForResponse(
			(r) => r.url().includes("/media?r=") && r.status() === 502,
		);
		await page
			.getByRole("button", { name: "HLS playback", exact: true })
			.click();
		const recoveryLease = await (await recoveryStart).json();
		const failedSegmentUrl = (await segmentFailure).url();
		expect(failedSegmentUrl).toContain(
			`/api/playback/${recoveryLease.id}/media`,
		);
		await expect
			.poll(() => fragmentAttempts, { timeout: 15000 })
			.toBeGreaterThanOrEqual(2);
		await expect
			.poll(
				() => hlsVideo.evaluate((node: HTMLVideoElement) => node.readyState),
				{ timeout: 15000 },
			)
			.toBeGreaterThanOrEqual(3);
		await hlsVideo.evaluate((node: HTMLVideoElement) => {
			node.muted = true;
			void node.play();
		});
		await expect
			.poll(() =>
				hlsVideo.evaluate((node: HTMLVideoElement) => node.currentTime),
			)
			.toBeGreaterThan(0.1);
		expect(
			await hlsVideo.evaluate((node: HTMLVideoElement) => node.error),
		).toBeNull();
		expect(fragmentFailuresRemaining).toBe(0);
		const recoveryDb = new Client({
			connectionString: process.env.DATABASE_URL,
		});
		await recoveryDb.connect();
		try {
			const leases = await recoveryDb.query(
				'SELECT id FROM "playbackLease" WHERE "userId"=$1',
				[viewerId],
			);
			expect(leases.rows).toEqual([{ id: recoveryLease.id }]);
			// Exercise the app's UTC expiry/session check instead of comparing a
			// Prisma timestamp-without-time-zone with PostgreSQL local NOW().
			expect(
				(
					await page.request.patch(`/api/playback/${recoveryLease.id}`, {
						headers: { ...headers, Origin: new URL(page.url()).origin },
					})
				).status(),
			).toBe(200);
		} finally {
			await recoveryDb.end();
		}
		// Recovery must not make the same media token usable anonymously or
		// by another logged-in session belonging to this viewer.
		expect((await anonymous.get(failedSegmentUrl)).status()).toBe(401);
		expect((await viewer.get(failedSegmentUrl)).status()).toBe(410);
		await page.getByRole("button", { name: "Zatvori plejer" }).click();
		await expect
			.poll(async () => (await page.request.get(failedSegmentUrl)).status())
			.toBe(410);

		await checkMobilePlayer(page);

		await page.goto(`${process.env.TEST_BASE_URL}/gledaj/filmovi`);
		await expect(
			page.getByRole("combobox", { name: "Kategorija", exact: true }),
		).toHaveValue("__favorites__");
		await page
			.getByRole("combobox", { name: "Kategorija", exact: true })
			.selectOption("");
		const workerStart = page.waitForResponse(
			(r) =>
				r.url().endsWith("/api/playback") && r.request().method() === "POST",
		);
		await page
			.getByRole("button", { name: "Worker film", exact: true })
			.click();
		await page.getByRole("button", { name: "Pusti film", exact: true }).click();
		const workerResponse = await workerStart;
		expect(workerResponse.status()).toBe(201);
		const workerResult = await workerResponse.json();
		expect(workerResult.format).toBe("hls");
		expect(workerResult.worker?.profile).toBe("remux");
		expect((await anonymous.get(workerResult.url)).status()).toBe(401);
		expect((await owner.get(workerResult.url)).status()).toBe(410);
		expect((await viewer.get(workerResult.url)).status()).toBe(410);
		const workerVideo = page.getByLabel("Video", { exact: true });
		await expect
			.poll(
				() => workerVideo.evaluate((node: HTMLVideoElement) => node.readyState),
				{ timeout: 25000 },
			)
			.toBeGreaterThanOrEqual(3);
		await workerVideo.evaluate((node: HTMLVideoElement) => {
			node.muted = true;
			void node.play();
		});
		await expect
			.poll(() =>
				workerVideo.evaluate((node: HTMLVideoElement) => node.currentTime),
			)
			.toBeGreaterThan(0);
		await expect(
			page.getByLabel("Pozicija filma", { exact: true }),
		).toBeVisible();
		await checkPlayerGestures(page);
		// Use the longer worker fixture: the short TV fixture ends before idle hiding.
		const workerPanel = page.getByRole("region", {
			name: "Plejer",
			exact: true,
		});
		await page.mouse.move(10, 10);
		await expect(workerPanel).not.toHaveClass(/controls-visible/, {
			timeout: 5000,
		});
		await page.mouse.move(100, 100);
		await expect(workerPanel).toHaveClass(/controls-visible/);
		await workerVideo.evaluate((node: HTMLVideoElement) => node.pause());
		await page.waitForTimeout(10500);
		const resumedStart = page.waitForResponse(
			(r) =>
				r.url().endsWith("/api/playback") && r.request().method() === "POST",
		);
		await workerVideo.evaluate((node: HTMLVideoElement) => {
			void node.play();
		});
		expect((await resumedStart).status()).toBe(201);
		await expect
			.poll(
				() => workerVideo.evaluate((node: HTMLVideoElement) => node.readyState),
				{ timeout: 15000 },
			)
			.toBeGreaterThanOrEqual(3);
		const captionStart = page.waitForResponse(
			(r) =>
				r.url().endsWith("/api/playback") &&
				r.request().method() === "POST" &&
				r.request().postDataJSON().subtitleIndex === 2,
		);
		await page
			.getByRole("button", { name: "Podešavanja plejera", exact: true })
			.click();
		await page
			.getByRole("combobox", { name: "Titlovi", exact: true })
			.selectOption("2");
		const captionResponse = await captionStart;
		expect(captionResponse.status()).toBe(201);
		const captionInfo = await captionResponse.json();
		await expect
			.poll(
				() =>
					workerVideo.evaluate((node: HTMLVideoElement) =>
						Array.from(node.textTracks).some(
							(track) =>
								track.mode === "showing" &&
								Array.from(track.activeCues ?? []).some(
									(cue) => (cue as VTTCue).text === "Worker subtitle",
								),
						),
					),
				{ timeout: 15000 },
			)
			.toBe(true)
			.catch(async (error) => {
				console.error("Generated subtitle fixture diagnostic", {
					offset: captionInfo.worker?.offset,
					video: await workerVideo.evaluate((node: HTMLVideoElement) => ({
						time: node.currentTime,
						paused: node.paused,
						error: node.error?.code ?? null,
						tracks: Array.from(node.textTracks).map((track) => ({
							mode: track.mode,
							cues: Array.from(track.cues ?? [])
								.slice(0, 20)
								.map((cue) => ({ start: cue.startTime, end: cue.endTime })),
						})),
					})),
				});
				throw error;
			});
		if (process.env.TEST_SCREENSHOT_DIR)
			await page.screenshot({
				path: `${process.env.TEST_SCREENSHOT_DIR}/worker-player.png`,
				fullPage: true,
			});
		const seekResponse = page.waitForResponse(
			(r) =>
				r.url().endsWith("/api/playback") &&
				r.request().method() === "POST" &&
				r.request().postDataJSON().offset === 7,
		);
		await page.getByLabel("Pozicija filma", { exact: true }).fill("7");

		const sought = await seekResponse;
		expect(sought.status()).toBe(201);
		expect((await sought.json()).worker.offset).toBe(7);
		await expect
			.poll(
				() => workerVideo.evaluate((node: HTMLVideoElement) => node.readyState),
				{ timeout: 25000 },
			)
			.toBeGreaterThanOrEqual(3);

		// A keyboard seek must restart at the requested source position, without
		// waiting for the transcoder to buffer all preceding media.
		const keyboardSeek = page.waitForResponse(
			(r) =>
				r.url().endsWith("/api/playback") &&
				r.request().method() === "POST" &&
				r.request().postDataJSON().offset === 1,
		);
		await page.getByLabel("Pozicija filma", { exact: true }).press("Home");
		await page
			.getByLabel("Pozicija filma", { exact: true })
			.press("ArrowRight");
		expect((await keyboardSeek).status()).toBe(201);
		await expect
			.poll(
				() => workerVideo.evaluate((node: HTMLVideoElement) => node.readyState),
				{ timeout: 25000 },
			)
			.toBeGreaterThanOrEqual(3);
		await page
			.getByRole("button", { name: "Zatvori plejer", exact: true })
			.click();
		await expect
			.poll(async () => {
				const r = await fetch(`${process.env.MEDIA_WORKER_URL}/health`, {
					headers: {
						Authorization: `Bearer ${process.env.MEDIA_WORKER_SECRET}`,
					},
				});
				return (await r.json()).jobs;
			})
			.toBe(0);
		await checkAdditionalBrowsers(page);
		await page.goto(`${process.env.TEST_BASE_URL}/gledaj/serije`);
		await expect(
			page.getByRole("combobox", { name: "Kategorija", exact: true }),
		).toHaveValue("__favorites__");
		await page
			.getByRole("combobox", { name: "Kategorija", exact: true })
			.selectOption("");
		await checkFavoriteCategory(page, "Test Show");
		await page.getByRole("button", { name: "Test Show", exact: true }).click();
		const showDetails = page.getByRole("dialog", {
			name: "Test Show",
			exact: true,
		});
		await expect(showDetails).toBeVisible();
		await expect(
			showDetails.getByRole("region", {
				name: "Sezone i epizode",
				exact: true,
			}),
		).toBeVisible();
		const season = showDetails.getByRole("combobox", {
			name: "Sezona",
			exact: true,
		});
		await expect(season).toHaveValue("1");
		await expect(
			showDetails.getByRole("button", {
				name: "Test Show S01E01",
				exact: true,
			}),
		).toBeVisible();
		await expect(
			showDetails.getByRole("button", {
				name: "Test Show S01E02",
				exact: true,
			}),
		).toBeVisible();
		await expect(page.getByLabel("Video", { exact: true })).toHaveCount(0);
		await captureDetails(page, "series-details");
		const nextEpisodeStart = page.waitForResponse(
			(r) =>
				r.url().endsWith("/api/playback") &&
				r.request().method() === "POST" &&
				r.request().postDataJSON().itemId === episodes.items[1].id,
		);
		await page
			.getByRole("button", { name: "Test Show S01E01", exact: true })
			.click();
		const episodeVideo = page.getByLabel("Video", { exact: true });
		await expect
			.poll(() =>
				episodeVideo.evaluate((node: HTMLVideoElement) => node.readyState),
			)
			.toBeGreaterThanOrEqual(3);
		await episodeVideo.evaluate((node: HTMLVideoElement) => {
			node.muted = true;
			void node.play();
		});
		await expect(
			page.getByRole("heading", { name: "Test Show S01E02", exact: true }),
		).toBeVisible({ timeout: 12000 });
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						document.fullscreenElement?.classList.contains(
							"vod-player-surface",
						) ?? false,
				),
			)
			.toBe(true);
		// Wait for the second playback request before closing; the title renders first.
		const nextEpisodeResponse = await nextEpisodeStart;
		expect(nextEpisodeResponse.status()).toBe(201);
		const nextEpisodeLease = await nextEpisodeResponse.json();
		await page
			.getByRole("button", { name: "Vrati na izbor", exact: true })
			.click();
		await expect(showDetails).toBeVisible();
		await expect
			.poll(() => page.evaluate(() => document.fullscreenElement === null))
			.toBe(true);

		await expect
			.poll(async () =>
				(
					await page.request.get(
						`${process.env.TEST_BASE_URL}${nextEpisodeLease.url}`,
					)
				).status(),
			)
			.toBe(410);
		// An idle job is revoked on source selection without another media request.
		const workerFilm = films.items.find(
			(item: { title: string }) => item.title === "Worker film",
		);
		const guarded = await viewer.post("/api/playback", {
			headers,
			data: { itemId: workerFilm.id },
		});
		expect(guarded.status()).toBe(201);
		const guardedLease = await guarded.json();
		await assign(viewerId, source.id);
		await expect
			.poll(
				async () => {
					const response = await fetch(
						`${process.env.MEDIA_WORKER_URL}/health`,
						{
							headers: {
								Authorization: `Bearer ${process.env.MEDIA_WORKER_SECRET}`,
							},
						},
					);
					return (await response.json()).jobs;
				},
				{ timeout: 8000 },
			)
			.toBe(0);
		expect((await viewer.get(guardedLease.url)).status()).toBe(410);
		// Private targets and redirects must remain blocked outside the exact fixture origin.
		const blocked = await (
			await owner.post("/api/admin/playlists", {
				data: {
					name: "Blocked",
					input: { kind: "url", url: `${origin}/redirect.m3u` },
				},
			})
		).json();
		expect(
			(
				await owner.post(`/api/admin/playlists/${blocked.id}/refresh`, {
					data: { revision: 1 },
				})
			).status(),
		).toBe(502);
		expect(hits).toBeGreaterThan(5);
	} finally {
		await rm(workerDir, { recursive: true, force: true });
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}
