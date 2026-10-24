import { apiUser, jsonResponse } from "@/server/http";
import { ownerDiagnostics } from "@/server/owner-diagnostics";

export async function GET(request: Request) {
	return jsonResponse(async () => {
		await apiUser(request, true);
		return ownerDiagnostics();
	});
}
