import { updateCategoryVisibility } from "@/lib/category-visibility";
import { apiUser, jsonResponse, readJson } from "@/server/http";
import { playlistCategories, savePlaylistCategories } from "@/server/playlists";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
	return jsonResponse(async () => {
		await apiUser(request, true);
		return playlistCategories((await context.params).id);
	});
}
export async function PUT(request: Request, context: Context) {
	return jsonResponse(async () => {
		await apiUser(request, true);
		return savePlaylistCategories(
			(await context.params).id,
			await readJson(request, updateCategoryVisibility, 2 * 1024 * 1024),
		);
	});
}
