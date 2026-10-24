import "server-only";
import { HttpError } from "./http";

function config() {
	const url = process.env.MEDIA_WORKER_URL;
	const secret = process.env.MEDIA_WORKER_SECRET;
	if (!url || !secret) throw new HttpError(503, "Media worker nije podešen.");
	const parsed = new URL(url);
	if (
		parsed.protocol !== "http:" ||
		parsed.hostname !== "127.0.0.1" ||
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash ||
		parsed.username ||
		parsed.password ||
		!/^[a-f0-9]{64}$/i.test(secret)
	)
		throw new HttpError(503, "Media worker nije ispravno podešen.");
	return { url: parsed.origin, secret };
}
const messages: Record<string, string> = {
	worker_capacity: "Media worker je zauzet. Pokušajte ponovo.",
	video_transcode_disabled:
		"Ovaj video zahteva konverziju koja još nije uključena na serveru.",
	startup_timeout: "Izvor nije spreman za reprodukciju. Pokušajte ponovo.",
	invalid_seek: "Premotavanje nije dostupno na toj poziciji.",
	probe_failed: "Format izvora nije moguće pročitati.",
	conversion_failed: "Obrada videa je prekinuta.",
	job_expired: "Reprodukcija je završena. Pokrenite ponovo.",
};
export async function workerRequest(
	path: string,
	method = "GET",
	data?: unknown,
) {
	const { url, secret } = config();
	let response: Response;
	try {
		response = await fetch(`${url}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${secret}`,
				"Content-Type": "application/json",
			},
			body: data === undefined ? undefined : JSON.stringify(data),
			signal: AbortSignal.timeout(method === "POST" ? 35000 : 5000),
			redirect: "error",
			cache: "no-store",
		});
	} catch {
		throw new HttpError(503, "Media worker trenutno nije dostupan.");
	}
	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: "" }));
		throw new HttpError(
			response.status,
			messages[error.error] ?? "Media obrada nije uspela.",
		);
	}
	return response;
}
export async function stopWorker(id: string | null | undefined) {
	if (!id) return;
	try {
		await workerRequest(`/jobs/${id}`, "DELETE");
	} catch (error) {
		if (!(error instanceof HttpError && [404, 410].includes(error.status)))
			throw error;
	}
}
export type WorkerResult = {
	id: string;
	duration: number | null;
	offset: number;
	profile: "remux" | "transcode";
	audioTracks: { index: number; language: string; codec: string }[];
	audioIndex: number | null;
	subtitleIndex: number | null;
	subtitleTracks: { index: number; language: string; codec: string }[];
};

export async function workerStream(path: string, signal: AbortSignal) {
	const { url, secret } = config();
	const connect = new AbortController();
	const timer = setTimeout(() => connect.abort(), 5000);
	try {
		const response = await fetch(`${url}${path}`, {
			headers: { Authorization: `Bearer ${secret}` },
			signal: AbortSignal.any([signal, connect.signal]),
			cache: "no-store",
			redirect: "error",
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new HttpError(response.status, "Media obrada nije uspela.");
		}
		return response;
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw new HttpError(503, "Media worker trenutno nije dostupan.");
	} finally {
		clearTimeout(timer);
	}
}
