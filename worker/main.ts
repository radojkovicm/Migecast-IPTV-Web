import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
} from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { providerRequest } from "../src/server/provider-http.js";
import { validateTemporaryStorage, workerConfig } from "./config.js";
import {
	ffmpegArgs,
	hlsSegmentOption,
	inputArgs,
	type JobInput,
	jobInput,
	playbackPlan,
	probeData,
	validContentRange,
	WorkerError,
} from "./plan.js";

const { secret, port, ffmpeg, ffprobe, allowTranscode, maxJobs, requireTmpfs } =
	workerConfig(process.env);
await validateTemporaryStorage(tmpdir(), requireTmpfs);
const jobTtl = 45000;
const maxDisk = 256 * 1024 * 1024;
const childEnv = {
	NODE_ENV: "production" as const,
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	LANG: "C",
	AV_LOG_FORCE_NOCOLOR: "1",
};
// Inspect the installed binary once, without provider URLs or credentials.
const capabilities = spawnSync(ffmpeg, ["-hide_banner", "-h", "muxer=hls"], {
	env: childEnv,
	encoding: "utf8",
	timeout: 5000,
	maxBuffer: 128 * 1024,
});
if (capabilities.status !== 0)
	throw new Error("FFmpeg HLS capability check failed");
const segmentOption = hlsSegmentOption(capabilities.stdout);
const root = await mkdtemp(join(tmpdir(), "migecast-worker-"));
type Job = {
	input: JobInput;
	token: string;
	directory: string;
	controller: AbortController;
	child?: ChildProcess;
	exit?: Promise<void>;
	ready: Promise<unknown>;
	prepared: Promise<void>;
	expires: number;
	created: number;
	status: string;
	stopping?: Promise<void>;
	bytes: number;
	gatewayRequests: number;
	plan?: ReturnType<typeof playbackPlan>;
};
const jobs = new Map<string, Job>();
const fileName = /^(index(?:_vtt)?\.m3u8|index\d{1,6}\.vtt|segment-\d{6}\.ts)$/;
let shuttingDown = false;
function json(res: ServerResponse, status: number, value: unknown) {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify(value));
}
function authorized(req: IncomingMessage) {
	const value = req.headers.authorization ?? "";
	const expected = `Bearer ${secret}`;
	return (
		Buffer.byteLength(value) === Buffer.byteLength(expected) &&
		timingSafeEqual(Buffer.from(value), Buffer.from(expected))
	);
}
async function stop(job: Job) {
	if (job.stopping) return job.stopping;
	job.stopping = (async () => {
		job.status = "stopped";
		job.controller.abort();
		if (job.child && job.child.exitCode === null) {
			job.child.kill("SIGTERM");
			const kill = setTimeout(() => job.child?.kill("SIGKILL"), 1500);
			await job.exit;
			clearTimeout(kill);
		}
		jobs.delete(job.input.id);
		await job.prepared.catch(() => {});
		await rm(job.directory, { recursive: true, force: true });
	})();
	return job.stopping;
}
async function probe(job: Job, url: string) {
	return new Promise<ReturnType<typeof probeData.parse>>((resolve, reject) => {
		const child = spawn(
			ffprobe,
			[
				"-v",
				"error",
				...inputArgs(job.input.container, url),
				"-show_entries",
				"stream=index,codec_type,codec_name,profile,level,pix_fmt,width,height:stream_tags=language:format=duration",
				"-of",
				"json",
			],
			{ env: childEnv, stdio: ["ignore", "pipe", "ignore"] },
		);
		job.child = child;
		const chunks: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, 12000);
		const abort = () => child.kill("SIGKILL");
		job.controller.signal.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 128 * 1024) {
				child.kill("SIGKILL");
				return;
			}
			chunks.push(chunk);
		});
		job.exit = new Promise<void>((done) => {
			child.once("error", () => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					job.controller.signal.removeEventListener("abort", abort);
					reject(new WorkerError(503, "ffprobe_unavailable"));
				}
				done();
			});
			child.once("close", (code) => {
				clearTimeout(timer);
				job.controller.signal.removeEventListener("abort", abort);
				done();
				if (settled) return;
				settled = true;
				if (code !== 0 || bytes > 128 * 1024) {
					reject(new WorkerError(502, "probe_failed"));
					return;
				}
				try {
					resolve(
						probeData.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
					);
				} catch {
					reject(new WorkerError(502, "probe_failed"));
				}
			});
		});
	});
}
async function start(job: Job) {
	try {
		await job.prepared;
		if (job.controller.signal.aborted) throw new WorkerError(410, "stopped");
		const url = `http://127.0.0.1:${port}/input/${job.token}`;
		const info = await probe(job, url);
		if (job.controller.signal.aborted) throw new WorkerError(410, "stopped");
		const plan = playbackPlan(job.input, info, allowTranscode);
		job.plan = plan;
		const child = spawn(
			ffmpeg,
			ffmpegArgs(job.input, url, plan, segmentOption),
			{
				cwd: job.directory,
				env: childEnv,
				stdio: ["ignore", "ignore", "ignore"],
			},
		);
		job.child = child;
		job.status = "starting";
		job.exit = new Promise<void>((resolve) => {
			child.once("error", () => {
				job.status = "failed";
				resolve();
			});
			child.once("close", (code) => {
				if (job.status !== "stopped")
					job.status = code === 0 ? "ended" : "failed";
				resolve();
			});
		});
		const deadline = Date.now() + 20000;
		while (Date.now() < deadline) {
			if (job.controller.signal.aborted || job.status === "failed")
				throw new WorkerError(502, "conversion_failed");
			try {
				const manifest = await readFile(
					join(job.directory, "index.m3u8"),
					"utf8",
				);
				if (manifest.includes("#EXTINF:")) {
					job.status = job.status === "ended" ? "ended" : "running";
					return {
						id: job.input.id,
						duration: plan.duration,
						offset: job.input.offset,
						profile: plan.copy ? "remux" : "transcode",
						audioTracks: plan.audioTracks,
						audioIndex: plan.audioIndex,
						subtitleTracks: plan.subtitleTracks,
						subtitleIndex: plan.subtitleIndex,
					};
				}
			} catch {
				/* Wait for the atomic first manifest. */
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new WorkerError(504, "startup_timeout");
	} catch (error) {
		await stop(job);
		throw error;
	}
}
async function body(req: IncomingMessage) {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const part of req) {
		size += part.length;
		if (size > 20000) throw new WorkerError(413, "body_too_large");
		chunks.push(part);
	}
	try {
		return jobInput.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	} catch {
		throw new WorkerError(400, "invalid_job");
	}
}
async function gateway(
	req: IncomingMessage,
	res: ServerResponse,
	token: string,
) {
	const job = [...jobs.values()].find((value) => value.token === token);
	if (!job || job.controller.signal.aborted) {
		res.writeHead(404);
		res.end();
		return;
	}
	if (job.gatewayRequests >= 2) throw new WorkerError(429, "input_busy");
	const range = req.headers.range;
	if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
		throw new WorkerError(416, "invalid_range");
	job.gatewayRequests++;
	const abort = new AbortController();
	const ended = () => abort.abort();
	res.once("close", ended);
	try {
		const upstream = await providerRequest(job.input.url, {
			signal: AbortSignal.any([abort.signal, job.controller.signal]),
			range,
		});
		const response = upstream.response;
		if (range && range !== "bytes=0-" && response.statusCode !== 206) {
			response.destroy();
			throw new WorkerError(422, "source_not_seekable");
		}
		if (
			response.statusCode === 206 &&
			!validContentRange(
				range,
				String(response.headers["content-range"] ?? ""),
				response.headers["content-length"],
			)
		) {
			response.destroy();
			throw new WorkerError(502, "invalid_source_range");
		}
		res.statusCode = response.statusCode ?? 200;
		res.setHeader("Content-Type", "application/octet-stream");
		for (const name of ["content-length", "content-range", "accept-ranges"]) {
			const value = response.headers[name];
			if (typeof value === "string") res.setHeader(name, value);
		}
		await pipeline(response, res);
	} finally {
		abort.abort();
		job.gatewayRequests--;
		res.removeListener("close", ended);
	}
}
const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url ?? "/", "http://worker.invalid");
		if (req.method === "GET" && /^\/input\/[a-f0-9]{64}$/.test(url.pathname)) {
			await gateway(req, res, url.pathname.slice(7));
			return;
		}
		if (!authorized(req)) {
			json(res, 401, { error: "unauthorized" });
			return;
		}
		if (req.method === "GET" && url.pathname === "/health") {
			json(res, 200, {
				ready: !shuttingDown,
				jobs: jobs.size,
				maxJobs,
				videoTranscode: allowTranscode,
			});
			return;
		}
		if (req.method === "POST" && url.pathname === "/jobs") {
			if (shuttingDown) throw new WorkerError(503, "shutting_down");
			const input = await body(req);
			const existing = jobs.get(input.id);
			if (existing) {
				if (JSON.stringify(existing.input) !== JSON.stringify(input))
					throw new WorkerError(409, "job_conflict");
				json(res, 200, await existing.ready);
				return;
			}
			if (jobs.size >= maxJobs) throw new WorkerError(503, "worker_capacity");
			const job: Job = {
				input,
				token: randomBytes(32).toString("hex"),
				directory: join(root, input.id),
				controller: new AbortController(),
				ready: Promise.resolve(),
				prepared: mkdir(join(root, input.id), { mode: 0o700 }),
				expires: Date.now() + jobTtl,
				created: Date.now(),
				status: "probing",
				bytes: 0,
				gatewayRequests: 0,
			};
			jobs.set(input.id, job);
			job.ready = start(job);
			json(res, 201, await job.ready);
			return;
		}
		const match = url.pathname.match(/^\/jobs\/([a-f0-9-]{36})(?:\/([^/]+))?$/);
		if (!match) throw new WorkerError(404, "not_found");
		const job = jobs.get(match[1]);
		if (req.method === "DELETE" && !match[2]) {
			if (job) await stop(job);
			json(res, 200, { ok: true });
			return;
		}
		if (!job) throw new WorkerError(410, "job_expired");
		if (req.method === "PATCH" && !match[2]) {
			if (job.status === "failed" || job.status === "stopped")
				throw new WorkerError(502, "conversion_failed");
			job.expires = Date.now() + jobTtl;
			json(res, 200, { ok: true });
			return;
		}
		if (req.method === "GET" && !match[2]) {
			json(res, 200, {
				status: job.status,
				bytes: job.bytes,
				profile: job.plan?.copy ? "remux" : "transcode",
			});
			return;
		}
		if (req.method === "GET" && match[2] === "master.m3u8") {
			if (
				!job.plan ||
				job.plan.subtitleIndex === null ||
				job.status === "failed"
			)
				throw new WorkerError(404, "file_unavailable");
			res.writeHead(200, {
				"Content-Type": "application/vnd.apple.mpegurl",
				"Cache-Control": "no-store",
			});
			res.end(
				'#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Titl",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="index_vtt.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,SUBTITLES="subs"\nindex.m3u8\n',
			);
			return;
		}
		if (req.method === "GET" && match[2] && fileName.test(match[2])) {
			if (job.status === "failed")
				throw new WorkerError(502, "conversion_failed");
			const path = join(job.directory, match[2]);
			const info = await lstat(path);
			if (
				!info.isFile() ||
				info.isSymbolicLink() ||
				info.size > 32 * 1024 * 1024
			)
				throw new WorkerError(404, "file_unavailable");
			res.writeHead(200, {
				"Content-Type": match[2].endsWith(".m3u8")
					? "application/vnd.apple.mpegurl"
					: match[2].endsWith(".vtt")
						? "text/vtt"
						: "video/mp2t",
				"Content-Length": info.size,
				"Cache-Control": "no-store",
			});
			await pipeline(createReadStream(path), res);
			return;
		}
		throw new WorkerError(404, "not_found");
	} catch (error) {
		if (res.headersSent) {
			res.destroy();
			return;
		}
		const known = error instanceof WorkerError;
		json(res, known ? error.status : 502, {
			error: known ? error.code : "worker_error",
		});
	}
});
server.requestTimeout = 35000;
server.headersTimeout = 10000;
server.maxConnections = 32;
let scanning = false;
const watchdog = setInterval(async () => {
	if (scanning) return;
	scanning = true;
	try {
		for (const job of jobs.values()) {
			if (
				Date.now() > job.expires ||
				Date.now() - job.created > 4 * 60 * 60 * 1000
			) {
				await stop(job);
				continue;
			}
			try {
				const names = await readdir(job.directory);
				let size = 0;
				for (const name of names) {
					size += (
						await stat(join(job.directory, name)).catch(() => ({ size: 0 }))
					).size;
				}
				job.bytes = size;
				if (size > maxDisk) await stop(job);
			} catch {
				/* Startup/cleanup may overlap the watchdog. */
			}
		}
	} finally {
		scanning = false;
	}
}, 1000);
async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	clearInterval(watchdog);
	server.close();
	await Promise.all([...jobs.values()].map(stop));
	server.closeAllConnections();
	await rm(root, { recursive: true, force: true });
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
server.listen(port, "127.0.0.1", () =>
	console.info(`Migecast media worker listening on 127.0.0.1:${port}`),
);
