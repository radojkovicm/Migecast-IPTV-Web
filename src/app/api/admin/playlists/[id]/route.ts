import { deletePlaylistInput, updatePlaylistInput } from "@/lib/playlist-input";
import { apiUser, jsonResponse, readJson } from "@/server/http";
import { deletePlaylist, updatePlaylist } from "@/server/playlists";

type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) {
	return jsonResponse(async () => {
		await apiUser(request, true);
		const { id } = await context.params;
		return updatePlaylist(id, await readJson(request, updatePlaylistInput));
	});
}
export async function DELETE(request: Request, context: Context) {
	return jsonResponse(async () => {
		await apiUser(request, true);
		const { id } = await context.params;
		const data = await readJson(request, deletePlaylistInput, 8192);
		return deletePlaylist(id, data.revision, data.detach);
	});
}
