import { z } from "zod";
import { getAuth } from "@/server/auth";
import { apiUser, HttpError, jsonResponse, readJson } from "@/server/http";
import { startPlayback } from "@/server/playback";
export async function POST(request: Request) {
	return jsonResponse(async () => {
		const user = await apiUser(request);
		const session = await getAuth().api.getSession({
			query: { disableRefresh: true },
			headers: request.headers,
		});
		if (!session) throw new HttpError(401, "Prijavite se ponovo.");
		const data = await readJson(
			request,
			z
				.object({
					itemId: z.string().max(100),
					mode: z.enum(["auto", "compatible"]).optional(),
					offset: z.number().finite().min(0).max(86400).optional(),
					resumePosition: z.number().finite().min(0).max(86400).optional(),
					audioIndex: z.number().int().min(0).max(100).optional(),
					subtitleIndex: z.number().int().min(0).max(100).optional(),
				})
				.strict(),
			1024,
		);
		return startPlayback(user.id, session.session.id, data.itemId, data);
	}, 201);
}
