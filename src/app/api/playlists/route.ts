import { apiUser, jsonResponse } from "@/server/http";
import { listOwnPlaylists } from "@/server/playlists";
export async function GET(request: Request) {
	return jsonResponse(async () => {
		const user = await apiUser(request);
		return listOwnPlaylists(user.id);
	});
}
