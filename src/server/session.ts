import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "./auth";
import { isOwner } from "./policy";

export async function requireSession() {
	const session = await getAuth().api.getSession({
		query: { disableRefresh: true },
		headers: await headers(),
	});
	if (!session) redirect("/login");
	return session;
}
export async function requireOwner() {
	const session = await requireSession();
	if (!isOwner(session.user)) redirect("/");
	return session;
}
