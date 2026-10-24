import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "migecast-worker-test-"));
async function freePort() {
	const server = tcpServer();
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	await new Promise((r) => server.close(r));
	return port;
}
function ffmpeg(args) {
	const r = spawnSync(
		process.env.FFMPEG_PATH ?? "ffmpeg",
		["-hide_banner", "-loglevel", "error", ...args],
		{ timeout: 20000, stdio: "pipe" },
	);
	assert.equal(r.status, 0, "Fixture generation failed");
}
let worker;
let provider;
let requests = 0;
let rangeSeeks = 0;
try {
	await writeFile(
		join(dir, "captions.srt"),
		"1\n00:00:00,000 --> 00:00:03,000\nFirst caption\n\n2\n00:00:07,000 --> 00:00:11,000\nLater caption\n",
	);
	ffmpeg([
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=320x180:rate=25",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:sample_rate=48000",
		"-i",
		join(dir, "captions.srt"),
		"-map",
		"0:v",
		"-map",
		"1:a",
		"-map",
		"2:s",
		"-c:s",
		"srt",
		"-metadata:s:s:0",
		"language=srp",
		"-t",
		"12",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-g",
		"25",
		"-c:a",
		"ac3",
		join(dir, "movie.mkv"),
	]);
	ffmpeg([
		"-i",
		join(dir, "movie.mkv"),
		"-map",
		"0:v",
		"-map",
		"0:a",
		"-c",
		"copy",
		"-f",
		"mpegts",
		join(dir, "live.ts"),
	]);
	ffmpeg([
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=160x90:rate=10",
		"-t",
		"4",
		"-c:v",
		"mpeg4",
		join(dir, "unsupported.mkv"),
	]);
	// A ten-minute fixture proves a fresh midpoint seek does not wait for
	// preceding media to be buffered or processed at the normal read rate.
	ffmpeg([
		"-stream_loop",
		"49",
		"-i",
		join(dir, "movie.mkv"),
		"-map",
		"0:v",
		"-map",
		"0:a",
		"-c",
		"copy",
		join(dir, "long-movie.mkv"),
	]);
	const files = new Map(
		await Promise.all(
			["movie.mkv", "long-movie.mkv", "live.ts", "unsupported.mkv"].map(
				async (name) => [name, await readFile(join(dir, name))],
			),
		),
	);
	provider = createServer((req, res) => {
		requests++;
		const content = files.get(req.url.slice(1));
		if (!content) {
			res.writeHead(404);
			res.end();
			return;
		}
		const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
		const start = range ? Number(range[1]) : 0;
		const end = range?.[2]
			? Math.min(Number(range[2]), content.length - 1)
			: content.length - 1;
		if (start > 0) rangeSeeks++;
		if (start >= content.length) {
			res.writeHead(416, { "Content-Range": `bytes */${content.length}` });
			res.end();
			return;
		}
		res.setHeader("Accept-Ranges", "bytes");
		res.setHeader("Content-Length", end - start + 1);
		if (range) {
			res.statusCode = 206;
			res.setHeader("Content-Range", `bytes ${start}-${end}/${content.length}`);
		}
		res.end(content.subarray(start, end + 1));
	});
	await new Promise((r) => provider.listen(0, "127.0.0.1", r));
	const sourceOrigin = `http://127.0.0.1:${provider.address().port}`;
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const secret = randomBytes(32).toString("hex");
	const headers = {
		Authorization: `Bearer ${secret}`,
		"Content-Type": "application/json",
	};
	worker = spawn(process.execPath, ["dist/worker/main.js"], {
		env: {
			...process.env,
			NODE_ENV: "development",
			MEDIA_WORKER_PORT: String(port),
			MEDIA_WORKER_SECRET: secret,
			MEDIA_TEST_ORIGIN: sourceOrigin,
			MEDIA_ALLOW_VIDEO_TRANSCODE: "0",
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 80; i++) {
		try {
			if ((await fetch(`${base}/health`, { headers })).ok) break;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	assert.equal((await fetch(`${base}/health`)).status, 401);
	const id = randomUUID();
	const input = {
		id,
		url: `${sourceOrigin}/movie.mkv`,
		container: "matroska",
		live: false,
		offset: 0,
	};
	const start = await fetch(`${base}/jobs`, {
		method: "POST",
		headers,
		body: JSON.stringify(input),
	});
	const info = await start.json();
	assert.equal(start.status, 201, JSON.stringify(info));
	assert.equal(info.profile, "remux");
	assert.ok(info.duration > 10);
	assert.equal(info.subtitleIndex, null);
	assert.deepEqual(
		info.subtitleTracks.map((track) => ({
			index: track.index,
			language: track.language,
		})),
		[{ index: 2, language: "srp" }],
	);
	assert.equal(
		(
			await fetch(`${base}/jobs`, {
				method: "POST",
				headers,
				body: JSON.stringify(input),
			})
		).status,
		200,
		"Idempotent create",
	);
	assert.equal(
		(
			await fetch(`${base}/jobs`, {
				method: "POST",
				headers,
				body: JSON.stringify({ ...input, id: randomUUID() }),
			})
		).status,
		503,
		"Global worker capacity",
	);
	const manifest = await (
		await fetch(`${base}/jobs/${id}/index.m3u8`, { headers })
	).text();
	assert.ok(manifest.startsWith("#EXTM3U"));
	assert.ok(!manifest.includes(sourceOrigin));
	const segment = manifest
		.split("\n")
		.find((line) => /^segment-\d+\.ts$/.test(line));
	assert.ok(segment);
	assert.ok(
		(
			await (
				await fetch(`${base}/jobs/${id}/${segment}`, { headers })
			).arrayBuffer()
		).byteLength > 0,
	);
	assert.equal(
		(await fetch(`${base}/jobs/${id}/../plan.ts`, { headers })).status,
		404,
	);
	assert.equal(
		(await fetch(`${base}/jobs/${id}`, { method: "DELETE", headers })).status,
		200,
	);
	assert.equal((await fetch(`${base}/health`, { headers })).ok, true);
	assert.equal(
		(await (await fetch(`${base}/health`, { headers })).json()).jobs,
		0,
	);
	const seekId = randomUUID();
	const seek = await fetch(`${base}/jobs`, {
		method: "POST",
		headers,
		body: JSON.stringify({ ...input, id: seekId, offset: 7, subtitleIndex: 2 }),
	});
	const seekInfo = await seek.json();
	assert.equal(seek.status, 201, JSON.stringify(seekInfo));
	assert.equal(seekInfo.offset, 7);
	assert.equal(seekInfo.subtitleIndex, 2);
	const subtitleMaster = await (
		await fetch(`${base}/jobs/${seekId}/master.m3u8`, { headers })
	).text();
	assert.ok(subtitleMaster.includes("TYPE=SUBTITLES"));
	assert.ok(subtitleMaster.includes('URI="index_vtt.m3u8"'));
	assert.ok(!subtitleMaster.includes(sourceOrigin));
	const subtitleManifest = await (
		await fetch(`${base}/jobs/${seekId}/index_vtt.m3u8`, { headers })
	).text();
	const subtitleSegment = subtitleManifest
		.split("\n")
		.find((line) => /^index\d+\.vtt$/.test(line));
	assert.ok(subtitleSegment);
	const captionResponse = await fetch(
		`${base}/jobs/${seekId}/${subtitleSegment}`,
		{ headers },
	);
	assert.equal(captionResponse.headers.get("content-type"), "text/vtt");
	const captionText = await captionResponse.text();
	assert.ok(captionText.startsWith("WEBVTT"));
	assert.ok(captionText.includes("Later caption"));
	const seekManifest = await (
		await fetch(`${base}/jobs/${seekId}/index.m3u8`, { headers })
	).text();
	const seekSegment = seekManifest
		.split("\n")
		.find((line) => /^segment-\d+\.ts$/.test(line));
	assert.ok(seekSegment);
	const seekBytes = Buffer.from(
		await (
			await fetch(`${base}/jobs/${seekId}/${seekSegment}`, { headers })
		).arrayBuffer(),
	);
	const timestamps = spawnSync(
		process.env.FFPROBE_PATH ?? "ffprobe",
		[
			"-v",
			"error",
			"-show_entries",
			"format=start_time",
			"-of",
			"default=nw=1:nk=1",
			"pipe:0",
		],
		{ input: seekBytes, timeout: 10000 },
	);
	assert.equal(timestamps.status, 0);
	const mediaStart = Number(timestamps.stdout.toString().trim());
	const cueStart = captionText.match(/([\d:.]+) -->/);
	assert.ok(cueStart);
	const subtitleStart = cueStart[1]
		.split(":")
		.reduce((total, part) => total * 60 + Number(part), 0);
	assert.ok(
		// Stream-copy seeks to the preceding 1-second keyframe in this fixture.
		Math.abs(subtitleStart - mediaStart - 1) < 0.1,
		`Subtitle and video clocks must remain aligned after seek: subtitle=${subtitleStart}, media=${mediaStart}`,
	);
	await fetch(`${base}/jobs/${seekId}`, { method: "DELETE", headers });
	const midpointId = randomUUID();
	const midpointStarted = Date.now();
	const midpoint = await fetch(`${base}/jobs`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			...input,
			id: midpointId,
			url: `${sourceOrigin}/long-movie.mkv`,
			offset: 300,
		}),
		signal: AbortSignal.timeout(25000),
	});
	const midpointInfo = await midpoint.json();
	assert.equal(midpoint.status, 201, JSON.stringify(midpointInfo));
	assert.ok(
		midpointInfo.duration >= 590,
		"Full duration remains independent of buffered segments",
	);
	assert.equal(midpointInfo.offset, 300);
	assert.ok(
		Date.now() - midpointStarted < 25000,
		"Five-minute seek must not process the preceding five minutes",
	);
	const midpointManifest = await (
		await fetch(`${base}/jobs/${midpointId}/index.m3u8`, { headers })
	).text();
	const midpointSegment = midpointManifest
		.split("\n")
		.find((line) => line.endsWith(".ts"));
	assert.ok(midpointSegment);
	const midpointBytes = Buffer.from(
		await (
			await fetch(`${base}/jobs/${midpointId}/${midpointSegment}`, { headers })
		).arrayBuffer(),
	);
	const midpointDecode = spawnSync(
		process.env.FFMPEG_PATH ?? "ffmpeg",
		[
			"-v",
			"error",
			"-f",
			"mpegts",
			"-i",
			"pipe:0",
			"-frames:v",
			"1",
			"-f",
			"null",
			"-",
		],
		{ input: midpointBytes, timeout: 10000 },
	);
	assert.equal(
		midpointDecode.status,
		0,
		"Midpoint produces a decodable video frame",
	);
	await fetch(`${base}/jobs/${midpointId}`, { method: "DELETE", headers });
	console.log(
		`Worker midpoint seek: 300s of ${Math.floor(midpointInfo.duration)}s, first decodable segment in ${Date.now() - midpointStarted}ms.`,
	);
	const tsId = randomUUID();
	const ts = await fetch(`${base}/jobs`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			...input,
			id: tsId,
			url: `${sourceOrigin}/live.ts`,
			container: "mpegts",
			live: true,
		}),
	});
	assert.equal(ts.status, 201, JSON.stringify(await ts.json()));
	await fetch(`${base}/jobs/${tsId}`, { method: "DELETE", headers });
	const unsupported = await fetch(`${base}/jobs`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			...input,
			id: randomUUID(),
			url: `${sourceOrigin}/unsupported.mkv`,
		}),
	});
	assert.equal(unsupported.status, 422);
	assert.equal((await unsupported.json()).error, "video_transcode_disabled");
	const malicious = await fetch(`${base}/jobs`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			...input,
			id: randomUUID(),
			url: "http://127.0.0.1:1/private",
		}),
	});
	assert.equal(malicious.status, 502);
	assert.equal(
		(await (await fetch(`${base}/health`, { headers })).json()).jobs,
		0,
	);
	assert.ok(requests > 3);
	assert.ok(rangeSeeks > 0, "VOD seeking used provider Range");
	const stopped = new Promise((resolve) => worker.once("exit", resolve));
	worker.kill("SIGTERM");
	await stopped;
	worker = spawn(process.execPath, ["dist/worker/main.js"], {
		env: {
			PATH: process.env.PATH,
			NODE_ENV: "development",
			MEDIA_WORKER_PORT: String(port),
			MEDIA_WORKER_SECRET: secret,
			MEDIA_TEST_ORIGIN: sourceOrigin,
			MEDIA_ALLOW_VIDEO_TRANSCODE: "1",
			FFMPEG_PATH: process.env.FFMPEG_PATH,
			FFPROBE_PATH: process.env.FFPROBE_PATH,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 80; i++) {
		try {
			if ((await fetch(`${base}/health`, { headers })).ok) break;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	const conversionId = randomUUID();
	const converted = await fetch(`${base}/jobs`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			...input,
			id: conversionId,
			url: `${sourceOrigin}/unsupported.mkv`,
		}),
	});
	assert.equal(converted.status, 201);
	assert.equal((await converted.json()).profile, "transcode");
	const convertedManifest = await (
		await fetch(`${base}/jobs/${conversionId}/index.m3u8`, { headers })
	).text();
	const convertedSegment = convertedManifest
		.split("\n")
		.find((line) => /^segment-\d+\.ts$/.test(line));
	assert.ok(convertedSegment);
	const bytes = Buffer.from(
		await (
			await fetch(`${base}/jobs/${conversionId}/${convertedSegment}`, {
				headers,
			})
		).arrayBuffer(),
	);
	const decoded = spawnSync(
		process.env.FFMPEG_PATH ?? "ffmpeg",
		["-v", "error", "-i", "pipe:0", "-f", "null", "-"],
		{ input: bytes, timeout: 10000 },
	);
	assert.equal(decoded.status, 0, "Transcoded segment must actually decode");
	// No heartbeat: a forgotten browser/app must not retain a worker slot.
	const expiryDeadline = Date.now() + 48000;
	let remaining = 1;
	while (Date.now() < expiryDeadline && remaining) {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		remaining = (await (await fetch(`${base}/health`, { headers })).json())
			.jobs;
	}
	assert.equal(
		remaining,
		0,
		"Worker TTL releases abandoned jobs independently of the app",
	);
	console.info(
		"Worker: MKV/TS, AC3 remux, selected text subtitles/VTT, VOD Range seek, capacity, auth, SSRF, opt-in video conversion/decode, expiry and cleanup passed.",
	);
} finally {
	if (worker && worker.exitCode === null) {
		const exited = new Promise((r) => worker.once("exit", r));
		worker.kill("SIGTERM");
		await exited;
	}
	provider?.closeAllConnections();
	if (provider) await new Promise((r) => provider.close(r));
	await rm(dir, { recursive: true, force: true });
}
