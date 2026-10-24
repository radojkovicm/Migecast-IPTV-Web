import { notFound } from "next/navigation";
import { CatalogBrowser } from "@/components/catalog-browser";
import { Header } from "@/components/header";
import { isOwner } from "@/server/policy";
import { requireSession } from "@/server/session";

const titles: Record<string, string> = {
	tv: "TV",
	filmovi: "Filmovi",
	serije: "Serije",
};
export const dynamic = "force-dynamic";
export default async function CatalogPage({
	params,
}: {
	params: Promise<{ section: string }>;
}) {
	const { user } = await requireSession();
	const { section } = await params;
	if (!Object.hasOwn(titles, section)) notFound();
	return (
		<>
			<Header
				name={user.name}
				owner={isOwner(user)}
				section={titles[section]}
			/>
			<main
				className={`catalog-page ${section === "tv" ? "tv-page" : "poster-page"}`}
			>
				<h1 className="sr-only">{titles[section]}</h1>
				<CatalogBrowser
					kind={
						section === "filmovi"
							? "movie"
							: section === "serije"
								? "series"
								: "tv"
					}
				/>
			</main>
		</>
	);
}
