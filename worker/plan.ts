import { z } from "zod";
export const jobInput = z
	.object({
		id: z.string().uuid(),
		url: z.string().url().max(16384),
		container: z.enum(["mpegts", "matroska", "mov"]),
		live: z.boolean(),
		offset: z.number().finite().min(0).max(86400).default(0),
		forceVideo: z.boolean().default(false),
		audioIndex: z.number().int().min(0).max(100).optional(),
		subtitleIndex: z.number().int().min(0).max(100).optional(),
	})
	.strict();
export type JobInput = z.infer<typeof jobInput>;
export const probeData = z.object({
	streams: z
		.array(
			z.object({
				index: z.number().int(),
				codec_type: z.string(),
				codec_name: z.string().optional(),
				profile: z.string().optional(),
				level: z.number().optional(),
				pix_fmt: z.string().optional(),
				width: z.number().optional(),
				height: z.number().optional(),
				tags: z.object({ language: z.string().optional() }).optional(),
			}),
		)
		.max(100),
	format: z.object({ duration: z.string().optional() }).optional(),
});
export type Probe = z.infer<typeof probeData>;
export class WorkerError extends Error {
	constructor(
		public status: number,
		public code: string,
	) {
		super(code);
	}
}
export function inputArgs(container: JobInput["container"], url: string) {
	return [
		"-protocol_whitelist",
		"http,tcp",
		"-format_whitelist",
		container,
		"-f",
		container,
		"-rw_timeout",
		"10000000",
		"-probesize",
		"2000000",
		"-analyzeduration",
		"3000000",
		...(container === "mov"
			? ["-enable_drefs", "0", "-use_absolute_path", "0"]
			: []),
		"-i",
		url,
	];
}
export function playbackPlan(
	input: JobInput,
	probe: Probe,
	allowTranscode: boolean,
) {
	const video = probe.streams.find((s) => s.codec_type === "video");
	if (!video) throw new WorkerError(422, "no_video");
	const audioTracks = probe.streams.filter((s) => s.codec_type === "audio");
	const audio =
		input.audioIndex === undefined
			? audioTracks[0]
			: audioTracks.find((s) => s.index === input.audioIndex);
	if (input.audioIndex !== undefined && !audio)
		throw new WorkerError(422, "invalid_audio");
	const subtitleTracks = probe.streams.filter(
		(s) =>
			s.codec_type === "subtitle" &&
			["subrip", "ass", "ssa", "webvtt", "mov_text", "text"].includes(
				s.codec_name ?? "",
			),
	);
	const subtitle =
		input.subtitleIndex === undefined
			? undefined
			: subtitleTracks.find((s) => s.index === input.subtitleIndex);
	if (input.subtitleIndex !== undefined && !subtitle)
		throw new WorkerError(422, "invalid_subtitle");
	const copy =
		video.codec_name === "h264" &&
		video.pix_fmt === "yuv420p" &&
		["Baseline", "Constrained Baseline", "Main", "High"].includes(
			video.profile ?? "",
		) &&
		(video.level ?? 999) <= 51 &&
		(video.width ?? 9999) <= 1920 &&
		(video.height ?? 9999) <= 1080 &&
		!input.forceVideo;
	if (!copy && !allowTranscode)
		throw new WorkerError(422, "video_transcode_disabled");
	const rawDuration = Number(probe.format?.duration);
	const duration =
		!input.live && Number.isFinite(rawDuration) && rawDuration > 0
			? rawDuration
			: null;
	if (input.live && input.offset !== 0)
		throw new WorkerError(422, "live_seek_unavailable");
	if (input.offset > 0 && (!duration || input.offset >= duration))
		throw new WorkerError(422, "invalid_seek");
	return {
		copy,
		duration,
		audioIndex: audio?.index ?? null,
		subtitleIndex: subtitle?.index ?? null,
		subtitleTracks: subtitleTracks.map((s) => ({
			index: s.index,
			language: s.tags?.language ?? "und",
			codec: s.codec_name ?? "unknown",
		})),
		audioTracks: audioTracks.map((s) => ({
			index: s.index,
			language: s.tags?.language ?? "und",
			codec: s.codec_name ?? "unknown",
		})),
		args: [
			"-map",
			`0:${video.index}`,
			...(audio ? ["-map", `0:${audio.index}`] : ["-an"]),
			...(subtitle
				? ["-map", `0:${subtitle.index}`, "-c:s", "webvtt"]
				: ["-sn"]),
			"-dn",
			...(copy
				? ["-c:v", "copy"]
				: [
						"-c:v",
						"libx264",
						"-preset",
						"veryfast",
						"-crf",
						"23",
						"-pix_fmt",
						"yuv420p",
						"-vf",
						"scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
						"-force_key_frames",
						"expr:gte(t,n_forced*2)",
						"-maxrate",
						"2500k",
						"-bufsize",
						"5000k",
					]),
			...(audio
				? [
						"-c:a",
						audio.codec_name === "aac" ? "copy" : "aac",
						...(audio.codec_name === "aac" ? [] : ["-b:a", "128k", "-ac", "2"]),
					]
				: []),
		],
	};
}
export function hlsSegmentOption(help: string) {
	if (/\s-hls_segment_options\s/.test(help)) return "-hls_segment_options";
	if (/\s-hls_ts_options\s/.test(help)) return "-hls_ts_options";
	throw new Error("FFmpeg HLS segment options are unavailable");
}

export function ffmpegArgs(
	input: JobInput,
	url: string,
	plan: ReturnType<typeof playbackPlan>,
	segmentOption = "-hls_segment_options",
) {
	return [
		"-nostdin",
		"-hide_banner",
		"-loglevel",
		"error",
		"-max_alloc",
		"67108864",
		"-threads",
		"2",
		"-filter_threads",
		"1",
		// -re also works on the pinned production FFmpeg 4.4 runtime.
		...(!input.live ? ["-re"] : []),
		...(input.offset ? ["-ss", String(input.offset)] : []),
		...inputArgs(input.container, url),
		...plan.args,
		"-threads",
		"2",
		"-max_muxing_queue_size",
		"1024",
		"-f",
		"hls",
		"-hls_time",
		"2",
		"-hls_list_size",
		"8",
		"-hls_delete_threshold",
		"2",
		"-hls_flags",
		"delete_segments+temp_file",
		// WebVTT has no timestamp map; keep TS and subtitle clocks aligned.
		...(plan.subtitleIndex !== null ? [segmentOption, "mpegts_copyts=1"] : []),
		"-hls_segment_filename",
		"segment-%06d.ts",
		"index.m3u8",
	];
}

// Validate byte identity before forwarding partial content to FFmpeg.
export function validContentRange(
	request: string | undefined,
	contentRange: string,
	length?: string,
) {
	const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
	if (!match) return false;
	const [start, end, total] = match.slice(1).map(Number);
	if (
		![start, end, total].every(Number.isSafeInteger) ||
		start > end ||
		end >= total
	)
		return false;
	if (length !== undefined && Number(length) !== end - start + 1) return false;
	if (!request) return false;
	const requested = /^bytes=(\d*)-(\d*)$/.exec(request);
	if (!requested) return false;
	const from = requested[1]
		? Number(requested[1])
		: Math.max(0, total - Number(requested[2]));
	const to =
		requested[1] && requested[2]
			? Math.min(Number(requested[2]), total - 1)
			: total - 1;
	return (
		Number.isSafeInteger(from) &&
		Number.isSafeInteger(to) &&
		start === from &&
		end === to
	);
}
