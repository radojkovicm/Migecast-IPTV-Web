"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { OwnerDiagnosticsData } from "@/server/owner-diagnostics";
import "./owner-diagnostics.css";

const labels = { tv: "TV", movie: "Filmovi", series: "Serije" };
function date(value: string | null) {
	return value ? new Date(value).toLocaleString("sr-Latn-RS") : "Nema podataka";
}
function playlistLink(id: string) {
	return `/admin/liste#playlist-${encodeURIComponent(id)}`;
}

export function OwnerDiagnostics() {
	const [data, setData] = useState<OwnerDiagnosticsData | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [search, setSearch] = useState("");
	const refresh = useCallback(async () => {
		setLoading(true);
		setError("");
		try {
			const response = await fetch("/api/admin/diagnostics", {
				cache: "no-store",
				signal: AbortSignal.timeout(15000),
			});
			if (!response.ok) throw new Error("unavailable");
			setData(await response.json());
		} catch {
			setError(
				"Provera nije uspela. Pokušaj ponovo; ako je prijava istekla, prijavi se ponovo.",
			);
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	const query = search.trim().toLocaleLowerCase("sr-Latn-RS");
	const matches = (...values: (string | null)[]) =>
		values.some((value) =>
			value?.toLocaleLowerCase("sr-Latn-RS").includes(query),
		);
	const users =
		data?.users.filter((user) =>
			matches(user.name, user.username, user.activePlaylistName),
		) ?? [];
	const playlists =
		data?.playlists.filter(
			(list) =>
				matches(list.name) ||
				users.some((user) => user.activePlaylistId === list.id),
		) ?? [];
	return (
		<section className="owner-diagnostics" aria-labelledby="diagnostics-title">
			<header>
				<div>
					<h2 id="diagnostics-title">Pregled korisnika i lista</h2>
					<p>Pronađi korisnika, proveri aktivnu listu i otvori podešavanje.</p>
				</div>
				<button
					type="button"
					className="button quiet"
					onClick={() => void refresh()}
					disabled={loading}
				>
					{loading ? "Proveravam…" : "Osveži stanje"}
				</button>
			</header>
			{error && (
				<p role="alert" className="diagnostics-warning">
					{error} {data && "Ispod je prethodno očitano stanje."}
				</p>
			)}
			{data && (
				<>
					<div className="diagnostics-service" role="status">
						<strong
							className={
								data.worker.ready ? "diagnostics-good" : "diagnostics-warning"
							}
						>
							{data.worker.ready
								? "Video servis dostupan"
								: "Video servis nije dostupan"}
						</strong>
						<span>
							{data.worker.jobs !== null && data.worker.maxJobs !== null
								? `Zauzeto ${data.worker.jobs} od ${data.worker.maxJobs} mesta za obradu videa.`
								: ""}
						</span>
						<small>Provereno: {date(data.checkedAt)}</small>
					</div>
					{!data.worker.ready && (
						<p className="diagnostics-warning">
							TV može raditi direktno, ali filmovi i serije koji zahtevaju
							obradu mogu biti nedostupni. Proveri media worker na serveru.
						</p>
					)}
					<p className="diagnostics-note">
						Ovo je stanje aplikacije, bez pokretanja kanala. Dostupnost izvora,
						lozinka liste i gledanje u drugim aplikacijama nisu provereni.
						„Omiljeni“ mogu biti prazni dok korisnik ne označi zvezdicu.
					</p>
					{data.limited && (
						<p className="diagnostics-warning">
							Prikaz je ograničen na prvih 100 korisnika, lista i aktivnih
							reprodukcija. Pretraga obuhvata samo prikazane stavke.
						</p>
					)}
					<label className="diagnostics-search">
						Pronađi korisnika ili listu
						<input
							type="search"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Ime, korisničko ime ili naziv liste"
						/>
					</label>
					<h3>Korisnici</h3>
					<div className="diagnostics-cards">
						{users.map((user) => {
							const list = data.playlists.find(
								(list) => list.id === user.activePlaylistId,
							);
							return (
								<article className="diagnostics-card" key={user.id}>
									<h4>
										{user.name}
										{user.username && <small>@{user.username}</small>}
									</h4>
									<p>
										Aktivna lista:{" "}
										<strong>
											{user.activePlaylistName ??
												(user.activePlaylistId
													? "Nije u ovom pregledu"
													: "Nije izabrana")}
										</strong>
									</p>
									<ul>
										{user.blocked && (
											<li className="diagnostics-warning">
												Nalog je blokiran — odblokiraj ga u upravljanju
												korisnicima.
											</li>
										)}
										{user.assignedLists === 0 ? (
											<li className="diagnostics-warning">
												Nema dodeljenih lista — dodeli i aktiviraj listu.
											</li>
										) : (
											!user.activePlaylistId && (
												<li className="diagnostics-warning">
													Lista je dodeljena, ali nije aktivirana — izaberi
													aktivnu listu.
												</li>
											)
										)}
										{list && !list.catalogReady && (
											<li className="diagnostics-warning">
												Katalog nije spreman — otvori listu i osveži sadržaj.
											</li>
										)}
										{list?.sections.every(
											(section) => section.allowedCategories === 0,
										) && (
											<li className="diagnostics-warning">
												Sve kategorije su skrivene — dozvoli kategorije na
												listi.
											</li>
										)}
										{user.blockedBy && (
											<li className="diagnostics-warning">
												Isti izvor koristi {user.blockedBy}. Otvori listu i
												proveri reprodukciju pre prekidanja.
											</li>
										)}
										{user.playing && (
											<li className="diagnostics-good">
												Aktivna reprodukcija u aplikaciji.
											</li>
										)}
										<li>
											{user.activeSessions} važećih prijava ·{" "}
											{user.assignedLists} dodeljenih lista
										</li>
									</ul>
									<small>
										Poslednja obnova važeće prijave:{" "}
										{date(user.lastSessionActivity)}. Ovo nije potvrda da je
										korisnik trenutno na ekranu.
									</small>
									<div className="diagnostics-actions">
										<Link
											className="button"
											href={`/admin/liste?user=${encodeURIComponent(user.id)}#assignments`}
										>
											Podesi liste korisnika
										</Link>
										{user.activePlaylistId && (
											<Link
												className="button quiet"
												href={playlistLink(user.activePlaylistId)}
											>
												Otvori aktivnu listu
											</Link>
										)}
									</div>
								</article>
							);
						})}
						{users.length === 0 && <p>Nema korisnika za ovu pretragu.</p>}
					</div>
					<h3>Liste</h3>
					<div className="diagnostics-cards">
						{playlists.map((list) => (
							<article className="diagnostics-card" key={list.id}>
								<h4>{list.name}</h4>
								<p
									className={
										list.catalogReady
											? "diagnostics-good"
											: "diagnostics-warning"
									}
								>
									{list.catalogReady
										? "Katalog je učitan"
										: "Katalog treba osvežiti"}
								</p>
								<small>
									Poslednje uspešno učitavanje: {date(list.catalogUpdatedAt)}
								</small>
								<ul>
									{list.sections.map((section) => (
										<li key={section.kind}>
											<strong>{labels[section.kind]}:</strong>{" "}
											{section.items.toLocaleString("sr-Latn-RS")} u katalogu ·{" "}
											{section.allowedCategories === null
												? "sve kategorije dozvoljene"
												: section.allowedCategories === 0
													? "sve kategorije skrivene"
													: `${section.allowedCategories} izabranih kategorija`}
										</li>
									))}
								</ul>
								<p>
									{list.occupiedBy
										? `Izvor koristi: ${list.occupiedBy}`
										: "Nema aktivne reprodukcije ovog izvora u aplikaciji."}
								</p>
								<div className="diagnostics-actions">
									<Link className="button" href={playlistLink(list.id)}>
										Uredi listu i kategorije
									</Link>
									{list.occupiedPlaylistId &&
										list.occupiedPlaylistId !== list.id && (
											<Link
												className="button quiet"
												href={playlistLink(list.occupiedPlaylistId)}
											>
												Otvori listu koja se gleda
											</Link>
										)}
								</div>
							</article>
						))}
						{playlists.length === 0 && <p>Nema lista za ovu pretragu.</p>}
					</div>
				</>
			)}
		</section>
	);
}
