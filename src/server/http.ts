import "server-only";
import type { z } from "zod";
import { getAuth } from "./auth";
import { readEnvironment } from "./environment";
import { canAdminister } from "./policy";

export class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}
export async function apiUser(request: Request, owner = false) {
	const session = await getAuth().api.getSession({
		query: { disableRefresh: true },
		headers: request.headers,
	});
	if (!session) throw new HttpError(401, "Prijavite se ponovo.");
	if (owner && !canAdminister(session.user))
		throw new HttpError(
			403,
			"Pristup je dozvoljen samo administratoru sa 2FA zaštitom.",
		);
	if (request.method !== "GET" && request.method !== "HEAD") {
		if (request.headers.get("origin") !== readEnvironment().BETTER_AUTH_URL)
			throw new HttpError(403, "Zahtev nije dozvoljen.");
		if (
			request.headers.get("content-type")?.split(";")[0].trim() !==
			"application/json"
		)
			throw new HttpError(415, "Očekivan je JSON zahtev.");
	}
	return session.user;
}
export async function readJson<T>(
	request: Request,
	schema: z.ZodType<T>,
	limit = 12 * 1024 * 1024,
): Promise<T> {
	if (Number(request.headers.get("content-length") ?? 0) > limit)
		throw new HttpError(413, "Zahtev je prevelik.");
	const reader = request.body?.getReader();
	if (!reader) throw new HttpError(400, "Nedostaju podaci.");
	let bytes = 0;
	const chunks: Uint8Array[] = [];
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > limit) {
				await reader.cancel();
				throw new HttpError(413, "Zahtev je prevelik.");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "Neispravni podaci.");
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success)
		throw new HttpError(400, "Proverite naziv, adresu i obavezna polja.");
	return parsed.data;
}
export async function jsonResponse(
	action: () => Promise<unknown>,
	status = 200,
) {
	const headers = { "Cache-Control": "no-store" };
	try {
		return Response.json(await action(), { status, headers });
	} catch (error) {
		if (error instanceof HttpError)
			return Response.json(
				{ error: error.message },
				{ status: error.status, headers },
			);
		// Do not serialize ORM/network errors: they may contain credentials or SQL values.
		return Response.json(
			{ error: "Radnja nije uspela. Pokušajte ponovo." },
			{ status: 500, headers },
		);
	}
}
