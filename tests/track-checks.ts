import type { ServerResponse } from "node:http";
import { expect, type Page } from "@playwright/test";

// The video rendition uses the generated fragmented-MP4 fixture already served by playback-checks.
export function serveTrackFixture(pathname: string, response: ServerResponse) {
	const fixtures: Record<string, string> = {
		"/play.m3u8":
			'#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Srpski",LANGUAGE="sr",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO,URI="captions.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,SUBTITLES="subs"\ntrack-video.m3u8\n',
		"/track-video.m3u8":
			'#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.1,\nfragment.m4s\n#EXT-X-ENDLIST\n',
		"/captions.m3u8":
			"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.1,\ncaptions.vtt\n#EXT-X-ENDLIST\n",
		"/captions.vtt":
			"WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\n00:00:00.000 --> 00:00:02.100\nProbni titl\n",
	};
	const body = fixtures[pathname];
	if (!body) return false;
	response.setHeader(
		"Content-Type",
		pathname.endsWith(".vtt") ? "text/vtt" : "application/vnd.apple.mpegurl",
	);
	response.end(body);
	return true;
}

export async function checkSubtitleControls(page: Page) {
	await page
		.getByRole("button", { name: "Podešavanja plejera", exact: true })
		.click();
	const selector = page.getByRole("combobox", { name: "Titlovi", exact: true });
	await expect(selector).toBeVisible();
	await expect(selector).toBeEnabled();
	await expect(selector).toHaveValue("-1");
	await selector.selectOption({ label: "Srpski" });
	const video = page.getByLabel("Video", { exact: true });
	await expect
		.poll(() =>
			video.evaluate((node: HTMLVideoElement) =>
				Array.from(node.textTracks).some(
					(track) =>
						track.mode === "showing" &&
						Array.from(track.cues ?? []).some(
							(cue) => (cue as VTTCue).text === "Probni titl",
						),
				),
			),
		)
		.toBe(true);
	await selector.selectOption("-1");
	await expect
		.poll(() =>
			video.evaluate((node: HTMLVideoElement) =>
				Array.from(node.textTracks).every(
					(track) => track.kind === "metadata" || track.mode !== "showing",
				),
			),
		)
		.toBe(true);

	await page
		.getByRole("button", { name: "Podešavanja plejera", exact: true })
		.click();
}
