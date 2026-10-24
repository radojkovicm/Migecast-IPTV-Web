export type PlaylistSummary = {
	id: string;
	name: string;
	kind: string;
	revision: number;
	entryCount: number | null;
	catalogRevision: number | null;
	catalogUpdatedAt: string | null;
	updatedAt: string;
};
export type PlaylistUser = {
	id: string;
	name: string;
	username: string | null;
	playlistRevision: number;
	playlistAssignments: { playlistId: string }[];
	playlistSelection: { playlistId: string } | null;
};
export type PlaylistInventory = {
	playlists: (PlaylistSummary & {
		_count: { assignments: number; catalogItems: number };
	})[];
	users: PlaylistUser[];
};
