import { statfs } from "node:fs/promises";
import { isAbsolute } from "node:path";

export function workerConfig(env: Record<string, string | undefined>) {
	const secret = env.MEDIA_WORKER_SECRET ?? "";
	if (!/^[a-f0-9]{64}$/i.test(secret))
		throw new Error("Configure MEDIA_WORKER_SECRET as 32 random bytes in hex.");
	const portText = env.MEDIA_WORKER_PORT ?? "3101";
	const port = Number(portText);
	if (!/^\d+$/.test(portText) || port < 1024 || port > 65535)
		throw new Error("Invalid worker port.");
	const jobs = env.MEDIA_WORKER_MAX_JOBS ?? "1";
	if (!/^[12]$/.test(jobs)) throw new Error("Worker jobs must be 1 or 2.");
	const transcode = env.MEDIA_ALLOW_VIDEO_TRANSCODE ?? "0";
	if (!/^[01]$/.test(transcode))
		throw new Error("Invalid video transcode policy.");
	const requireTmpfs = env.MEDIA_WORKER_REQUIRE_TMPFS ?? "0";
	if (!/^[01]$/.test(requireTmpfs))
		throw new Error("Invalid temporary storage policy.");
	if (env.NODE_ENV === "production" && env.MEDIA_TEST_ORIGIN)
		throw new Error("Test origin is forbidden in production.");
	for (const key of ["FFMPEG_PATH", "FFPROBE_PATH"])
		if (env[key] && !isAbsolute(env[key]))
			throw new Error(`${key} must be an absolute path.`);
	return {
		secret,
		port,
		maxJobs: Number(jobs),
		allowTranscode: transcode === "1",
		requireTmpfs: requireTmpfs === "1",
		ffmpeg: env.FFMPEG_PATH ?? "ffmpeg",
		ffprobe: env.FFPROBE_PATH ?? "ffprobe",
	};
}

export async function validateTemporaryStorage(
	path: string,
	required: boolean,
) {
	if (!required) return;
	const fs = await statfs(path);
	if (process.platform !== "linux" || fs.type !== 0x01021994)
		throw new Error(
			"Worker temporary storage must be a private size-limited tmpfs.",
		);
	const capacity = fs.bsize * fs.blocks;
	if (capacity <= 0 || capacity > 256 * 1024 * 1024)
		throw new Error(
			"Worker temporary filesystem must be bounded to at most 256 MiB.",
		);
}
