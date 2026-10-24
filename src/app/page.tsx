import Link from "next/link";
import { Header } from "@/components/header";
import { getDb } from "@/server/db";
import { listOwnPlaylists } from "@/server/playlists";
import { isOwner } from "@/server/policy";
import { requireSession } from "@/server/session";

export const dynamic = "force-dynamic";
export default async function HomePage() {
	const { user } = await requireSession();
	const lists = await listOwnPlaylists(user.id);
	const active = lists.playlists.find(
		(list) => list.id === lists.activePlaylistId,
	);
	const counts = active
		? await getDb().catalogItem.groupBy({
				by: ["kind"],
				where: {
					playlistId: active.id,
					kind: { in: ["tv", "movie", "series"] },
				},
				_count: { _all: true },
			})
		: [];
	const count = (key: string) =>
		counts.find(
			(row) =>
				row.kind ===
				(key === "filmovi" ? "movie" : key === "serije" ? "series" : "tv"),
		)?._count._all ?? 0;
	return (
		<>
			<Header name={user.name} owner={isOwner(user)} />
			<main className="container home-page">
				<div className="sections">
					{[
						{
							key: "tv",
							label: "TV",
							icon: "M4 6h16v12H4z M8 22l4-4 4 4 M8 2l4 4 4-4",
						},
						{
							key: "filmovi",
							label: "Filmovi",
							icon: "M3 5h18v16H3z M3 10h18 M8 5v5 M16 5v5 M10 13l5 3-5 3z",
						},
						{
							key: "serije",
							label: "Serije",
							icon: "M3 9h18v12H3z M6 5h12 M9 1h6 M10 12l5 3-5 3z",
						},
					].map((section) => (
						<Link
							className={`section-card ${section.key}`}
							href={`/gledaj/${section.key}`}
							key={section.key}
							aria-label={section.label}
						>
							<span className="section-icon" aria-hidden="true">
								<svg
									width="42"
									height="42"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.7"
									strokeLinecap="round"
									strokeLinejoin="round"
									aria-hidden="true"
								>
									<path d={section.icon} />
								</svg>
							</span>
							<h2>{section.label}</h2>
							<span className="section-count">({count(section.key)})</span>
						</Link>
					))}
				</div>
				<div className="notice">
					<span className="status-dot" />
					<p>
						{active ? `Aktivna lista: ${active.name}` : "Nema aktivne liste."}
					</p>
					{isOwner(user) && (
						<Link className="button quiet" href="/admin/liste">
							Liste
						</Link>
					)}
				</div>
			</main>
		</>
	);
}
