import { z } from "zod";
import { getAuth } from "@/server/auth";
import { apiUser, HttpError, jsonResponse, readJson } from "@/server/http";
import { saveProgress } from "@/server/viewing";
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
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
					position: z.number().finite().min(0).max(86400),
					duration: z.number().finite().positive().max(86400),
					completed: z.boolean().optional(),
				})
				.strict(),
			1024,
		);
		return saveProgress(user.id, session.session.id, (await params).id, data);
	});
}
