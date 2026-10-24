import { z } from "zod";
import { apiUser, jsonResponse, readJson } from "@/server/http";
import { setFavorite } from "@/server/viewing";
export async function PUT(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	return jsonResponse(async () => {
		const user = await apiUser(request);
		const { favorite } = await readJson(
			request,
			z.object({ favorite: z.boolean() }).strict(),
			1024,
		);
		return setFavorite(user.id, (await params).id, favorite);
	});
}
