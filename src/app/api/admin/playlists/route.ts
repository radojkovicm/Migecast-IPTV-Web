import { createPlaylistInput } from "@/lib/playlist-input";
import { apiUser, jsonResponse, readJson } from "@/server/http";
import { adminPlaylists, savePlaylist } from "@/server/playlists";
export async function GET(request: Request) {
	return jsonResponse(async () => {
		await apiUser(request, true);
		return adminPlaylists();
	});
}
export async function POST(request: Request) {
	return jsonResponse(async () => {
		await apiUser(request, true);
		const data = await readJson(request, createPlaylistInput);
		return savePlaylist(data.name, data.input);
	}, 201);
}
