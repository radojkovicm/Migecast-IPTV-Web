import { selectionInput } from "@/lib/playlist-input";
import { apiUser, jsonResponse, readJson } from "@/server/http";
import { selectPlaylist } from "@/server/playlists";
export async function PUT(
	request: Request,
	context: { params: Promise<{ id: string }> },
) {
	return jsonResponse(async () => {
		await apiUser(request, true);
		const { id } = await context.params;
		return selectPlaylist(id, await readJson(request, selectionInput, 8192));
	});
}
