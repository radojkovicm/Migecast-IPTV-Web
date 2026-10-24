import { z } from "zod";
import { swapFavoriteChannels } from "@/server/favorite-order";
import { apiUser, jsonResponse, readJson } from "@/server/http";
export async function PUT(request: Request) {
	return jsonResponse(async () => {
		const user = await apiUser(request);
		const data = await readJson(
			request,
			z
				.object({
					itemId: z.string().min(1).max(128),
					neighborId: z.string().min(1).max(128),
					direction: z.union([z.literal(-1), z.literal(1)]),
				})
				.strict(),
			1024,
		);
		return swapFavoriteChannels(
			user.id,
			data.itemId,
			data.neighborId,
			data.direction,
		);
	});
}
