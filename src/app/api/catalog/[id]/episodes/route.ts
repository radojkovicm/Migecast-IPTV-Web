import { episodes } from "@/server/catalog";
import { apiUser, jsonResponse } from "@/server/http";
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	return jsonResponse(async () =>
		episodes((await apiUser(request)).id, (await params).id),
	);
}
