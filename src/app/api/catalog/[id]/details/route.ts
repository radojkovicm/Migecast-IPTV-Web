import { mediaDetails } from "@/server/catalog";
import { apiUser, jsonResponse } from "@/server/http";
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	return jsonResponse(async () =>
		mediaDetails((await apiUser(request)).id, (await params).id),
	);
}
