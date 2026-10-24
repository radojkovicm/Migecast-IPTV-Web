export function trackLabel(
	name: string | undefined,
	language: string | undefined,
	index: number,
	fallback: string,
) {
	return (
		name?.trim() ||
		(language && language !== "und" ? language : `${fallback} ${index + 1}`)
	);
}

type Caption = Pick<TextTrack, "kind" | "label" | "language" | "mode">;

export function captionTracks(tracks: ArrayLike<Caption>) {
	return Array.from(tracks, (track, index) => ({
		index,
		label: trackLabel(track.label, track.language, index, "Titl"),
		kind: track.kind,
		mode: track.mode,
	})).filter(
		(track) => track.kind === "subtitles" || track.kind === "captions",
	);
}

export function selectCaptionTrack(tracks: ArrayLike<Caption>, index: number) {
	for (const track of captionTracks(tracks)) {
		tracks[track.index].mode = track.index === index ? "showing" : "disabled";
	}
}
