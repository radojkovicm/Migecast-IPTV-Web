import { describe, expect, it } from "vitest";
import {
	ffmpegArgs,
	hlsSegmentOption,
	jobInput,
	type Probe,
	playbackPlan,
	validContentRange,
} from "./plan";

const input = jobInput.parse({
	id: "76290f86-37f7-4e88-8626-4e3af3be2050",
	url: "https://example.org/movie.mkv",
	container: "matroska",
	live: false,
});
const video = {
	index: 0,
	codec_type: "video",
	codec_name: "h264",
	profile: "High",
	level: 41,
	pix_fmt: "yuv420p",
	width: 1920,
	height: 1080,
};
const probe: Probe = {
	streams: [
		video,
		{ index: 1, codec_type: "audio", codec_name: "ac3" },
		{ index: 2, codec_type: "audio", codec_name: "aac" },
	],
	format: { duration: "120" },
};

describe("Worker policy", () => {
	it("detects the installed HLS option across FFmpeg generations", () => {
		expect(hlsSegmentOption("  -hls_ts_options <dictionary> options")).toBe(
			"-hls_ts_options",
		);
		expect(
			hlsSegmentOption("  -hls_segment_options <dictionary> options"),
		).toBe("-hls_segment_options");
		expect(() => hlsSegmentOption("unknown muxer")).toThrow();
	});
	it("paces VOD with FFmpeg 4.4-compatible flags and seeks before opening input", () => {
		const seeking = { ...input, offset: 90 };
		const args = ffmpegArgs(
			seeking,
			"http://127.0.0.1/input/test",
			playbackPlan(seeking, probe, false),
		);
		expect(args).toContain("-re");
		expect(args).not.toContain("-readrate");
		expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
		expect(args[args.indexOf("-ss") + 1]).toBe("90");
		const live = { ...input, live: true };
		expect(
			ffmpegArgs(
				live,
				"http://127.0.0.1/input/test",
				playbackPlan(live, probe, false),
			),
		).not.toContain("-re");
	});
	it("keeps compatible video, converts AC3 and respects explicit audio selection", () => {
		const plan = playbackPlan(input, probe, false);
		expect(plan.copy).toBe(true);
		expect(
			plan.args.slice(
				plan.args.indexOf("-c:a") + 1,
				plan.args.indexOf("-c:a") + 2,
			),
		).toEqual(["aac"]);
		expect(
			playbackPlan({ ...input, audioIndex: 2 }, probe, false).audioIndex,
		).toBe(2);
		expect(() =>
			playbackPlan({ ...input, audioIndex: 99 }, probe, false),
		).toThrow("invalid_audio");
	});
	it("converts only explicitly selected text subtitles and excludes bitmap tracks", () => {
		const withSubtitles: Probe = {
			...probe,
			streams: [
				...probe.streams,
				{
					index: 3,
					codec_type: "subtitle",
					codec_name: "subrip",
					tags: { language: "srp" },
				},
				{ index: 4, codec_type: "subtitle", codec_name: "hdmv_pgs_subtitle" },
				{ index: 5, codec_type: "subtitle", codec_name: "ass" },
			],
		};
		const disabled = playbackPlan(input, withSubtitles, false);
		expect(disabled.subtitleTracks.map((track) => track.index)).toEqual([3, 5]);
		expect(disabled.subtitleIndex).toBeNull();
		expect(disabled.args).toContain("-sn");
		const enabled = playbackPlan(
			{ ...input, subtitleIndex: 3 },
			withSubtitles,
			false,
		);
		expect(enabled.subtitleIndex).toBe(3);
		expect(enabled.args).not.toContain("-sn");
		expect(enabled.args.join(" ")).toContain("-map 0:3 -c:s webvtt");
		for (const subtitleIndex of [1, 4, 99])
			expect(() =>
				playbackPlan({ ...input, subtitleIndex }, withSubtitles, false),
			).toThrow("invalid_subtitle");
	});

	it("does not copy incompatible H264 profiles and never silently enables video transcoding", () => {
		for (const change of [
			{ pix_fmt: "yuv420p10le" },
			{ profile: "High 10" },
			{ width: 3840 },
			{ codec_name: "hevc" },
			{ level: 62 },
		]) {
			const incompatible = { ...probe, streams: [{ ...video, ...change }] };
			expect(() => playbackPlan(input, incompatible, false)).toThrow(
				"video_transcode_disabled",
			);
			expect(playbackPlan(input, incompatible, true).copy).toBe(false);
		}
	});
	it("rejects seeking live, unknown-duration and out-of-bounds sources", () => {
		expect(() =>
			playbackPlan({ ...input, live: true, offset: 1 }, probe, false),
		).toThrow("live_seek_unavailable");
		expect(() => playbackPlan({ ...input, offset: 120 }, probe, false)).toThrow(
			"invalid_seek",
		);
		expect(() =>
			playbackPlan({ ...input, offset: 1 }, { streams: [video] }, false),
		).toThrow("invalid_seek");
	});
	it("rejects mismatched, truncated, overflowing and unsolicited partial responses", () => {
		expect(validContentRange("bytes=50-", "bytes 50-99/100", "50")).toBe(true);
		expect(validContentRange("bytes=-10", "bytes 90-99/100", "10")).toBe(true);
		for (const range of [
			"bytes 0-99/100",
			"bytes 50-100/100",
			"bytes 50-98/100",
			"bytes 50-99999999999999999999/999999999999999999999",
		])
			expect(validContentRange("bytes=50-", range)).toBe(false);
		expect(validContentRange("bytes=50-", "bytes 50-99/100", "49")).toBe(false);
		expect(validContentRange(undefined, "bytes 0-99/100")).toBe(false);
	});
});
