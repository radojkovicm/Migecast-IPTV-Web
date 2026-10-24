import { authorizedItem } from "@/server/catalog";
import { apiUser } from "@/server/http";
import { providerRequest, readProviderBody } from "@/server/provider-http";
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const user = await apiUser(request);
		const { locator } = await authorizedItem(user.id, (await params).id);
		if (!locator.artwork) return new Response(null, { status: 404 });
		const result = await providerRequest(locator.artwork, {
			signal: AbortSignal.timeout(10000),
		});
		const type = String(result.response.headers["content-type"] ?? "").split(
			";",
		)[0];
		if (
			!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type)
		) {
			result.response.destroy();
			return new Response(null, { status: 415 });
		}
		const bytes = await readProviderBody(result.response, 3 * 1024 * 1024);
		return new Response(new Uint8Array(bytes), {
			headers: {
				"Content-Type": type,
				"Cache-Control": "private, no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch {
		return new Response(null, { status: 404 });
	}
}
