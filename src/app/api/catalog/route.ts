import { catalog } from "@/server/catalog";
import { apiUser, jsonResponse } from "@/server/http";
export async function GET(request: Request) {
	return jsonResponse(async () => {
		const user = await apiUser(request);
		const q = new URL(request.url).searchParams;
		const kind = q.get("kind") ?? "tv";
		return catalog(user.id, {
			kind: ["tv", "movie", "series"].includes(kind) ? kind : "tv",
			search: (q.get("q") ?? "").slice(0, 100),
			favorites: q.get("favorites") === "1",
			category: (q.get("category") ?? "").slice(0, 300),
			page: Math.min(8333, Math.max(0, Math.floor(Number(q.get("page"))) || 0)),
		});
	});
}
