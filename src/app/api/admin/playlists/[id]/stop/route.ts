import { getDb } from "@/server/db";
import { apiUser, HttpError, jsonResponse } from "@/server/http";
import { abortMedia } from "@/server/media-connections";
import { stopWorker } from "@/server/worker-client";
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	return jsonResponse(async () => {
		await apiUser(request, true);
		const source = await getDb().playlist.findUnique({
			where: { id: (await params).id },
			select: { providerKey: true },
		});
		if (!source) throw new HttpError(404, "Lista nije pronađena.");
		const leases = await getDb().playbackLease.findMany({
			where: { providerKey: source.providerKey },
			select: { id: true, workerJobId: true },
		});
		await getDb().playbackLease.deleteMany({
			where: { providerKey: source.providerKey },
		});
		for (const lease of leases) {
			abortMedia(lease.id);
			await stopWorker(lease.workerJobId);
		}
		return { ok: true };
	});
}
