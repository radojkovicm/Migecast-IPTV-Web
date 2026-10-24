import { z } from "zod";
import { refreshCatalog } from "@/server/catalog";
import { apiUser, jsonResponse, readJson } from "@/server/http";
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	return jsonResponse(async () => {
		await apiUser(request, true);
		const data = await readJson(
			request,
			z.object({ revision: z.number().int().positive() }).strict(),
			1024,
		);
		return refreshCatalog((await params).id, data.revision);
	});
}
