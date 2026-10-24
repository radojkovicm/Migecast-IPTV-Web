import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authorizedItem } from "./catalog";
import { getDb } from "./db";
import { HttpError } from "./http";
import { abortMedia, registerMedia } from "./media-connections";
import { decryptPlaylist, encryptPlaylist } from "./playlist-crypto";
import { inspectMedia, providerRequest } from "./provider-http";
import { stopWorker, type WorkerResult, workerRequest } from "./worker-client";

const resource = z
	.object({
		url: z.string().url().max(16384),
		mime: z.enum(["video/mp4", "video/webm"]).optional(),
	})
	.strict();
export function mediaPath(leaseId: string, url: string, mime?: string) {
	return `/api/playback/${leaseId}/media?r=${encodeURIComponent(encryptPlaylist(`playback:${leaseId}`, { url, mime }))}`;
}
export function readResource(leaseId: string, token: string) {
	try {
		if (token.length > 30000) throw new Error();
		return resource.parse(decryptPlaylist(`playback:${leaseId}`, token));
	} catch {
		throw new HttpError(403, "Neispravan zahtev za reprodukciju.");
	}
}
export async function checkLease(
	userId: string,
	sessionId: string,
	id: string,
) {
	const lease = await getDb().playbackLease.findFirst({
		where: { id, userId, sessionId, expiresAt: { gt: new Date() } },
	});
	if (!lease)
		throw new HttpError(410, "Reprodukcija je završena. Pokrenite ponovo.");
	const [selection, source, session] = await Promise.all([
		getDb().playlistSelection.findUnique({ where: { userId } }),
		getDb().playlist.findUnique({
			where: { id: lease.playlistId },
			select: { revision: true, providerKey: true },
		}),
		getDb().session.findFirst({
			where: {
				id: sessionId,
				userId,
				expiresAt: { gt: new Date() },
				user: { banned: { not: true } },
			},
			select: { id: true },
		}),
	]);
	if (
		!session ||
		selection?.playlistId !== lease.playlistId ||
		source?.revision !== lease.sourceRevision ||
		source.providerKey !== lease.providerKey
	)
		throw new HttpError(403, "Pristup reprodukciji je promenjen.");
	return lease;
}
export async function startPlayback(
	userId: string,
	sessionId: string,
	itemId: string,
	options: {
		mode?: "auto" | "compatible";
		offset?: number;
		resumePosition?: number;
		audioIndex?: number;
		subtitleIndex?: number;
	} = {},
) {
	const { source, item, locator } = await authorizedItem(userId, itemId);
	if (!locator.url || item.kind === "series")
		throw new HttpError(400, "Izaberite epizodu.");
	const id = randomUUID();
	let replacedId: string | undefined;
	let replacedWorker: string | null | undefined;
	try {
		await getDb().$transaction(async (tx) => {
			for (const key of [
				`provider:${source.providerKey}`,
				`user:${userId}`,
			].sort())
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
			const selected = await tx.playlistSelection.findUnique({
				where: { userId },
			});
			const current = await tx.playlist.findUnique({
				where: { id: source.id },
			});
			if (
				selected?.playlistId !== source.id ||
				current?.revision !== source.revision ||
				current.visibilityRevision !== source.visibilityRevision
			)
				throw new HttpError(409, "Lista je promenjena.");

			await tx.playbackLease.deleteMany({
				where: { expiresAt: { lte: new Date() } },
			});
			const existing = await tx.playbackLease.findFirst({
				where: { OR: [{ providerKey: source.providerKey }, { userId }] },
			});
			if (
				existing &&
				(existing.userId !== userId || existing.sessionId !== sessionId)
			)
				throw new HttpError(409, "Lista ili nalog se već koristi za gledanje.");
			replacedId = existing?.id;
			replacedWorker = existing?.workerJobId;
			await tx.playbackLease.deleteMany({ where: { userId, sessionId } });
			await tx.playbackLease.create({
				data: {
					id,
					providerKey: source.providerKey,
					userId,
					sessionId,
					playlistId: source.id,
					sourceRevision: source.revision,
					itemId,
					expiresAt: new Date(Date.now() + 75000),
				},
			});
		});
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw new HttpError(409, "Reprodukcija se već pokreće. Pokušajte ponovo.");
	}

	if (replacedId) abortMedia(replacedId);
	try {
		await stopWorker(replacedWorker);
	} catch (error) {
		await stopPlayback(userId, sessionId, id);
		throw error;
	}
	const controller = new AbortController();
	const unregister = registerMedia(id, () => controller.abort());
	let format: string;
	let mime: string | undefined;
	let container: string | undefined;
	let worker: WorkerResult | undefined;
	try {
		const probe = await providerRequest(locator.url, {
			signal: AbortSignal.any([AbortSignal.timeout(15000), controller.signal]),
			range: "bytes=0-4095",
		});
		try {
			const inspected = await inspectMedia(probe.response);
			format = inspected.kind;
			mime = inspected.mime;
			container = inspected.container;
		} finally {
			probe.response.destroy();
		}

		if (
			format === "worker" ||
			options.mode === "compatible" ||
			(options.offset ?? 0) > 0
		) {
			if (!container)
				throw new HttpError(
					422,
					"Ovaj izvor još nije podržan u kompatibilnom režimu.",
				);
			worker = (await (
				await workerRequest("/jobs", "POST", {
					id,
					url: locator.url,
					container,
					live: item.kind === "tv",
					offset: options.offset || options.resumePosition || 0,
					forceVideo: options.mode === "compatible",
					audioIndex: options.audioIndex,
					subtitleIndex: options.subtitleIndex,
				})
			).json()) as WorkerResult;
			const saved = await getDb().playbackLease.updateMany({
				where: { id, userId, sessionId },
				data: { workerJobId: id },
			});
			if (!saved.count) {
				await stopWorker(id);
				throw new HttpError(410, "Reprodukcija je promenjena.");
			}
			// Observe revocation even when a paused browser stops requesting segments.
			// This guard never renews the lease: only authenticated client activity does.
			let checking = false;
			const guard = setInterval(async () => {
				if (checking) return;
				checking = true;
				try {
					await checkLease(userId, sessionId, id);
				} catch {
					abortMedia(id);
				} finally {
					checking = false;
				}
			}, 3000);
			guard.unref();
			registerMedia(id, () => {
				clearInterval(guard);
				void stopWorker(id).catch(() => {});
			});
			format = "hls";
		} else if (format === "binary")
			throw new HttpError(422, "Format izvora nije podržan.");
	} catch (error) {
		await stopWorker(id).catch(() => {});
		await stopPlayback(userId, sessionId, id);
		if (error instanceof HttpError) throw error;
		throw new HttpError(502, "Izvor trenutno nije dostupan.");
	} finally {
		unregister();
	}
	try {
		await checkLease(userId, sessionId, id);
	} catch (error) {
		abortMedia(id);
		await stopWorker(worker?.id).catch(() => {});
		throw error;
	}
	return {
		id,
		url: worker
			? `/api/playback/${id}/worker/${worker.subtitleIndex != null ? "master.m3u8" : "index.m3u8"}`
			: mediaPath(id, locator.url, mime),
		worker: worker ?? null,
		resumePosition: options.resumePosition ?? 0,
		format,
		title: item.title,
		live: item.kind === "tv",
	};
}
export async function heartbeat(userId: string, sessionId: string, id: string) {
	const lease = await checkLease(userId, sessionId, id);
	if (lease.workerJobId)
		await workerRequest(`/jobs/${lease.workerJobId}`, "PATCH");
	const result = await getDb().playbackLease.updateMany({
		where: { id, userId, sessionId, expiresAt: { gt: new Date() } },
		data: { expiresAt: new Date(Date.now() + 75000) },
	});
	if (!result.count) throw new HttpError(410, "Reprodukcija je završena.");
	return { ok: true };
}
export async function stopPlayback(
	userId: string,
	sessionId: string,
	id: string,
) {
	const lease = await getDb().playbackLease.findFirst({
		where: { id, userId, sessionId },
		select: { workerJobId: true },
	});
	const stopped = await getDb().playbackLease.deleteMany({
		where: { id, userId, sessionId },
	});
	if (stopped.count) {
		abortMedia(id);
		await stopWorker(lease?.workerJobId);
	}
	return { ok: true };
}
export function rewriteHls(body: string, base: string, leaseId: string) {
	if (
		!body.startsWith("#EXTM3U") ||
		body.includes("#EXT-X-DEFINE") ||
		body.includes("#EXT-X-CONTENT-STEERING")
	)
		throw new HttpError(502, "Nepodržan HLS manifest.");
	const uri = (value: string) => {
		const url = new URL(value, base);
		if (
			!["https:", "http:"].includes(url.protocol) ||
			url.username ||
			url.password
		)
			throw new HttpError(502, "Nepodržan media izvor.");
		return mediaPath(leaseId, url.href);
	};

	const allowed = new Set([
		"EXTM3U",
		"EXTINF",
		"EXT-X-VERSION",
		"EXT-X-TARGETDURATION",
		"EXT-X-MEDIA-SEQUENCE",
		"EXT-X-DISCONTINUITY-SEQUENCE",
		"EXT-X-ENDLIST",
		"EXT-X-PLAYLIST-TYPE",
		"EXT-X-INDEPENDENT-SEGMENTS",
		"EXT-X-START",
		"EXT-X-DISCONTINUITY",
		"EXT-X-GAP",
		"EXT-X-BYTERANGE",
		"EXT-X-PROGRAM-DATE-TIME",
		"EXT-X-KEY",
		"EXT-X-MAP",
		"EXT-X-MEDIA",
		"EXT-X-STREAM-INF",
		"EXT-X-I-FRAME-STREAM-INF",
		"EXT-X-SESSION-KEY",
		"EXT-X-PART",
		"EXT-X-PART-INF",
		"EXT-X-SERVER-CONTROL",
		"EXT-X-PRELOAD-HINT",
		"EXT-X-RENDITION-REPORT",
		"EXT-X-SKIP",
	]);
	return body
		.split(/\r?\n/)
		.map((line) => {
			const trimmed = line.trim();
			if (!trimmed) return "";
			if (!trimmed.startsWith("#")) return uri(trimmed);
			if (!allowed.has(trimmed.slice(1).split(":")[0])) return "";
			if (trimmed.startsWith("#EXTINF:")) return `${trimmed.split(",")[0]},`;
			const rewritten = trimmed.replace(
				/URI="([^"]+)"/g,
				(_match, value) => `URI="${uri(value)}"`,
			);
			if (/https?:\/\//i.test(rewritten))
				throw new HttpError(502, "Nepodržan HLS atribut.");
			return rewritten;
		})
		.join("\n");
}
