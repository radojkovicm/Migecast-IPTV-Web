import Link from "next/link";
import { Header } from "@/components/header";
import { MfaSetup } from "@/components/mfa-setup";
import { PlaylistManager } from "@/components/playlist-manager";
import { adminPlaylists } from "@/server/playlists";
import { canAdminister } from "@/server/policy";
import { requireOwner } from "@/server/session";

export const dynamic = "force-dynamic";
export default async function PlaylistPage({
	searchParams,
}: {
	searchParams: Promise<{ user?: string }>;
}) {
	const requestedUserId = (await searchParams).user;
	const { user } = await requireOwner();
	const inventory = canAdminister(user) ? await adminPlaylists() : null;
	const initial = inventory
		? {
				...inventory,
				playlists: inventory.playlists.map((playlist) => ({
					...playlist,
					updatedAt: playlist.updatedAt.toISOString(),
					catalogUpdatedAt: playlist.catalogUpdatedAt?.toISOString() ?? null,
				})),
			}
		: null;
	return (
		<>
			<Header name={user.name} owner />
			<main className="container">
				<nav className="actions" aria-label="Podešavanja">
					<Link className="button quiet" href="/">
						← Nazad
					</Link>
					<Link className="button quiet" href="/admin">
						Korisnici
					</Link>
				</nav>
				<h1>Liste</h1>
				{initial ? (
					<PlaylistManager
						key={requestedUserId ?? user.id}
						initial={initial}
						ownerId={user.id}
						selectedUser={requestedUserId}
					/>
				) : (
					<MfaSetup />
				)}
			</main>
		</>
	);
}
