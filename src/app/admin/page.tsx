import Link from "next/link";
import { AdminPanel } from "@/components/admin-panel";
import { Header } from "@/components/header";
import { MfaSetup } from "@/components/mfa-setup";
import { OwnerDiagnostics } from "@/components/owner-diagnostics";
import { getDb } from "@/server/db";
import { canAdminister } from "@/server/policy";
import { requireOwner } from "@/server/session";

export const dynamic = "force-dynamic";
export default async function AdminPage() {
	const { user } = await requireOwner();
	const users = canAdminister(user)
		? await getDb().user.findMany({
				select: { id: true, name: true, username: true, banned: true },
				orderBy: { createdAt: "asc" },
				take: 100,
			})
		: [];
	return (
		<>
			<Header name={user.name} owner />
			<main className="container">
				<Link className="button quiet" href="/">
					← Nazad
				</Link>
				<h1>Administracija</h1>
				<Link className="button primary" href="/admin/liste">
					Upravljanje listama
				</Link>
				{canAdminister(user) ? (
					<>
						<OwnerDiagnostics />
						<div id="accounts">
							<AdminPanel users={users} ownerId={user.id} />
						</div>
					</>
				) : (
					<MfaSetup />
				)}
			</main>
		</>
	);
}
