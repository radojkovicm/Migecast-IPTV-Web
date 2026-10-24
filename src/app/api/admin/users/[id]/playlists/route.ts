import { assignmentInput } from "@/lib/playlist-input";
import { apiUser, jsonResponse, readJson } from "@/server/http";
import { assignPlaylists } from "@/server/playlists";
export async function PUT(
	request: Request,
	context: { params: Promise<{ id: string }> },
) {
	return jsonResponse(async () => {
		await apiUser(request, true);
		const { id } = await context.params;
		return assignPlaylists(id, await readJson(request, assignmentInput, 65536));
	});
}
