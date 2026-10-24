import { HttpError } from "@/server/http";
import { serveMedia } from "@/server/media";
export const runtime = "nodejs";
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		return await serveMedia(request, (await params).id);
	} catch (error) {
		return Response.json(
			{
				error:
					error instanceof HttpError
						? error.message
						: "Reprodukcija nije uspela.",
			},
			{
				status: error instanceof HttpError ? error.status : 502,
				headers: { "Cache-Control": "no-store" },
			},
		);
	}
}
