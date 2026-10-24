import { getAuth } from "@/server/auth";
import { apiUser, HttpError, jsonResponse } from "@/server/http";
import { heartbeat, stopPlayback } from "@/server/playback";

async function action(
	request: Request,
	params: Promise<{ id: string }>,
	stop = false,
) {
	return jsonResponse(async () => {
		const user = await apiUser(request);
		const session = await getAuth().api.getSession({
			query: { disableRefresh: true },
			headers: request.headers,
		});
		if (!session) throw new HttpError(401, "Prijavite se ponovo.");
		return (stop ? stopPlayback : heartbeat)(
			user.id,
			session.session.id,
			(await params).id,
		);
	});
}
export async function PATCH(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	return action(request, params);
}
export async function DELETE(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	return action(request, params, true);
}
