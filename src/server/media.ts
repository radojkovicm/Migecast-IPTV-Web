import "server-only";
import { getAuth } from "./auth";
import { HttpError } from "./http";
import { registerMedia } from "./media-connections";
import { heartbeat, readResource, rewriteHls } from "./playback";
import { inspectMedia, providerRequest } from "./provider-http";

const state = globalThis as unknown as { mediaSlots?: Map<string, number> };
if (!state.mediaSlots) state.mediaSlots = new Map<string, number>();
const slots = state.mediaSlots;
export async function serveMedia(request: Request, id: string) {
	const session = await getAuth().api.getSession({
		query: { disableRefresh: true },
		headers: request.headers,
	});
	if (!session) throw new HttpError(401, "Prijavite se ponovo.");
	await heartbeat(session.user.id, session.session.id, id);
	if ((slots.get(id) ?? 0) >= 8)
		throw new HttpError(429, "Previše media zahteva.");
	const token = new URL(request.url).searchParams.get("r") ?? "";
	const { url, mime } = readResource(id, token);
	const range = request.headers.get("range") ?? undefined;
	if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
		throw new HttpError(416, "Neispravan opseg.");
	slots.set(id, (slots.get(id) ?? 0) + 1);
	const controller = new AbortController();
	const unregister = registerMedia(id, () => controller.abort());
	const onAbort = () => controller.abort();
	request.signal.addEventListener("abort", onAbort, { once: true });
	let done = false;
	const cleanup = () => {
		if (done) return;
		done = true;
		unregister();
		controller.abort();
		clearInterval(guard);

		request.signal.removeEventListener("abort", onAbort);
		const count = (slots.get(id) ?? 1) - 1;
		if (count <= 0) slots.delete(id);
		else slots.set(id, count);
	};
	let checking = false;
	const guard = setInterval(async () => {
		if (checking) return;
		checking = true;
		try {
			await heartbeat(session.user.id, session.session.id, id);
		} catch {
			cleanup();
		} finally {
			checking = false;
		}
	}, 3000);

	try {
		const upstream = await providerRequest(url, {
			signal: controller.signal,
			range,
		});
		const type = String(upstream.response.headers["content-type"] ?? "");
		const headers = new Headers({
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
		});

		const inspected = await inspectMedia(upstream.response);
		if (inspected.kind === "hls") {
			const chunks = [inspected.chunk];
			let size = inspected.chunk.length;
			if (size > 2 * 1024 * 1024)
				throw new HttpError(502, "Manifest je prevelik.");
			for await (const chunk of {
				[Symbol.asyncIterator]: () => inspected.iterator,
			}) {
				size += chunk.length;
				if (size > 2 * 1024 * 1024)
					throw new HttpError(502, "Manifest je prevelik.");
				chunks.push(Buffer.from(chunk));
			}
			const manifest = rewriteHls(
				Buffer.concat(chunks)
					.toString("utf8")
					.replace(/^\uFEFF/, ""),
				upstream.url,
				id,
			);
			cleanup();
			headers.set("Content-Type", "application/vnd.apple.mpegurl");
			return new Response(manifest, { headers });
		}

		// Never relay HTML, redirects, cookies, provider URLs or arbitrary response headers.
		if (/text\/html|application\/(json|xml)|image\/svg/i.test(type)) {
			upstream.response.destroy();
			throw new HttpError(502, "Izvor nije vratio media sadržaj.");
		}
		headers.set(
			"Content-Type",
			inspected.mime ??
				mime ??
				(/^(video|audio)\/[\w.+-]+/.test(type) || type === "text/vtt"
					? type.split(";")[0]
					: "application/octet-stream"),
		);
		for (const name of ["content-length", "content-range", "accept-ranges"]) {
			const value = upstream.response.headers[name];
			if (typeof value === "string") headers.set(name, value);
		}
		const iterator = inspected.iterator;
		let first = true;
		const body = new ReadableStream<Uint8Array>({
			async pull(target) {
				try {
					if (first) {
						first = false;
						target.enqueue(new Uint8Array(inspected.chunk));
						return;
					}
					const result = await iterator.next();
					if (result.done) {
						cleanup();
						target.close();
					} else target.enqueue(new Uint8Array(result.value));
				} catch {
					cleanup();
					target.error(new Error("Media connection ended"));
				}
			},
			cancel() {
				upstream.response.destroy();
				cleanup();
			},
		});
		return new Response(body, {
			status: upstream.response.statusCode,
			headers,
		});
	} catch (error) {
		cleanup();
		if (error instanceof HttpError) throw error;
		throw new HttpError(502, "Izvor trenutno nije dostupan.");
	}
}
