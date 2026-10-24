import { getAuth } from "@/server/auth";
import { HttpError } from "@/server/http";
import { registerMedia } from "@/server/media-connections";
import { checkLease, heartbeat } from "@/server/playback";
import { workerStream } from "@/server/worker-client";
export const runtime = "nodejs";
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ id: string; file: string }> },
) {
	try {
		const { id, file } = await params;
		if (
			!/^(master\.m3u8|index(?:_vtt)?\.m3u8|index\d{1,6}\.vtt|segment-\d{6}\.ts)$/.test(
				file,
			)
		)
			throw new HttpError(404, "Sadržaj nije pronađen.");
		const session = await getAuth().api.getSession({
			query: { disableRefresh: true },
			headers: request.headers,
		});
		if (!session) throw new HttpError(401, "Prijavite se ponovo.");
		const lease = await checkLease(session.user.id, session.session.id, id);
		if (lease.workerJobId !== id)
			throw new HttpError(404, "Sadržaj nije pronađen.");
		await heartbeat(session.user.id, session.session.id, id);
		const controller = new AbortController();
		const unregister = registerMedia(id, () => controller.abort());
		let checking = false;
		const guard = setInterval(async () => {
			if (checking) return;
			checking = true;
			try {
				await checkLease(session.user.id, session.session.id, id);
			} catch {
				controller.abort();
			} finally {
				checking = false;
			}
		}, 3000);
		const cleanup = () => {
			clearInterval(guard);
			unregister();
			request.signal.removeEventListener("abort", cleanup);
			controller.signal.removeEventListener("abort", cleanup);
			controller.abort();
		};
		request.signal.addEventListener("abort", cleanup, { once: true });
		controller.signal.addEventListener("abort", cleanup, { once: true });
		if (request.signal.aborted) cleanup();
		let response: Response;
		try {
			response = await workerStream(
				`/jobs/${id}/${file}`,
				AbortSignal.any([controller.signal, request.signal]),
			);
		} catch (error) {
			cleanup();
			throw error;
		}
		const reader = response.body?.getReader();
		if (!reader) {
			cleanup();
			throw new HttpError(502, "Sadržaj nije dostupan.");
		}
		const body = new ReadableStream({
			async pull(stream) {
				try {
					const next = await reader.read();
					if (next.done) {
						cleanup();
						stream.close();
					} else stream.enqueue(next.value);
				} catch {
					cleanup();
					stream.error(new Error("Media transfer interrupted"));
				}
			},
			async cancel() {
				cleanup();
				await reader.cancel().catch(() => {});
			},
		});
		return new Response(body, {
			headers: {
				"Content-Type": file.endsWith(".m3u8")
					? "application/vnd.apple.mpegurl"
					: file.endsWith(".vtt")
						? "text/vtt; charset=utf-8"
						: "video/mp2t",
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
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
