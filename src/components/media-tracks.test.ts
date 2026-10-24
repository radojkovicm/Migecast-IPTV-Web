import { describe, expect, it } from "vitest";
import { captionTracks, selectCaptionTrack, trackLabel } from "./media-tracks";

describe("media tracks", () => {
	it("preserves native indices and does not disable metadata tracks", () => {
		const tracks = [
			{ kind: "metadata", label: "Events", language: "", mode: "hidden" },
			{ kind: "subtitles", label: "Srpski", language: "sr", mode: "disabled" },
			{
				kind: "captions",
				label: "English CC",
				language: "en",
				mode: "showing",
			},
		] as Pick<TextTrack, "kind" | "label" | "language" | "mode">[];
		expect(captionTracks(tracks).map((track) => track.index)).toEqual([1, 2]);
		selectCaptionTrack(tracks, 1);
		expect(tracks.map((track) => track.mode)).toEqual([
			"hidden",
			"showing",
			"disabled",
		]);
		selectCaptionTrack(tracks, -1);
		expect(tracks.map((track) => track.mode)).toEqual([
			"hidden",
			"disabled",
			"disabled",
		]);
	});
	it("uses provider labels, language or a numbered fallback", () => {
		expect(trackLabel("Srpski", "sr", 0, "Titl")).toBe("Srpski");
		expect(trackLabel(" ", "en", 0, "Audio")).toBe("en");
		expect(trackLabel(undefined, "und", 1, "Audio")).toBe("Audio 2");
	});
});
