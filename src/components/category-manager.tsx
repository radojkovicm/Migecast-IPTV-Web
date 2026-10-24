"use client";
import { useRef, useState } from "react";
import {
	allCategories,
	type CategoryVisibility,
} from "@/lib/category-visibility";
import "./category-manager.css";

type Inventory = {
	revision: number;
	sourceRevision: number;
	visibility: CategoryVisibility;
	categories: { kind: string; name: string; count: number }[];
};
const labels = { tv: "TV", movie: "Filmovi", series: "Serije" };
export function CategoryManager({
	playlistId,
	name,
}: {
	playlistId: string;
	name: string;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [inventory, setInventory] = useState<Inventory | null>(null);
	const [visibility, setVisibility] =
		useState<CategoryVisibility>(allCategories);
	const [kind, setKind] = useState<keyof CategoryVisibility>("tv");
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	async function open() {
		dialog.current?.showModal();
		setBusy(true);
		setError("");
		setMessage("");
		setInventory(null);
		setQuery("");
		try {
			const r = await fetch(`/api/admin/playlists/${playlistId}/categories`);
			const data = await r.json();
			if (!r.ok) throw new Error(data.error);
			setInventory(data);
			setVisibility(data.visibility);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Kategorije nisu učitane.");
		} finally {
			setBusy(false);
		}
	}
	async function save() {
		if (!inventory) return;
		setBusy(true);
		setError("");
		setMessage("");
		try {
			const r = await fetch(`/api/admin/playlists/${playlistId}/categories`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					revision: inventory.revision,
					sourceRevision: inventory.sourceRevision,
					visibility,
				}),
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error);
			setInventory({
				...inventory,
				revision: inventory.revision + 1,
				visibility,
			});
			setMessage("Vidljive kategorije su sačuvane.");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Čuvanje nije uspelo.");
		} finally {
			setBusy(false);
		}
	}
	const categories =
		inventory?.categories.filter((row) => row.kind === kind) ?? [];
	const selected = visibility[kind];
	return (
		<>
			<button type="button" className="quiet" onClick={() => void open()}>
				Vidljive kategorije
			</button>
			<dialog
				ref={dialog}
				className="category-dialog"
				aria-label={`Vidljive kategorije: ${name}`}
			>
				<header>
					<h2>Vidljive kategorije · {name}</h2>
					<button
						type="button"
						disabled={busy}
						aria-label="Zatvori kategorije"
						onClick={() => dialog.current?.close()}
					>
						✕
					</button>
				</header>
				<p>
					Važi za sve korisnike ove liste, uključujući administratora pri
					gledanju. Skriveni sadržaj se ne prikazuje ni u pretrazi ni u
					omiljenima. Čuvanje prekida aktivno gledanje ove liste.
				</p>
				{busy && <p role="status">Učitavanje…</p>}
				{error && (
					<p role="alert" className="error">
						{error}{" "}
						<button type="button" disabled={busy} onClick={() => void open()}>
							Učitaj ponovo
						</button>
					</p>
				)}
				{message && <p role="status">{message}</p>}
				{inventory && (
					<fieldset disabled={busy}>
						<div className="category-tabs">
							{(Object.keys(labels) as (keyof CategoryVisibility)[]).map(
								(key) => (
									<button
										type="button"
										key={key}
										aria-pressed={kind === key}
										onClick={() => {
											setKind(key);
											setQuery("");
										}}
									>
										{labels[key]}
									</button>
								),
							)}
						</div>
						<div className="category-actions">
							<button
								type="button"
								onClick={() => setVisibility((v) => ({ ...v, [kind]: null }))}
							>
								Prikaži sve
							</button>
							<button
								type="button"
								onClick={() => setVisibility((v) => ({ ...v, [kind]: [] }))}
							>
								Sakrij sve
							</button>
							<span>
								{selected === null
									? "Sve sadašnje i nove kategorije"
									: `${categories.filter((c) => selected.includes(c.name)).length} od ${categories.length} vidljivih`}
							</span>
						</div>
						<label>
							Pretraži kategorije
							<input
								type="search"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
							/>
						</label>
						<div className="category-options">
							{categories
								.filter((c) =>
									c.name
										.toLocaleLowerCase()
										.includes(query.toLocaleLowerCase()),
								)
								.map((row) => (
									<label key={row.name}>
										<input
											type="checkbox"
											checked={selected === null || selected.includes(row.name)}
											onChange={(e) => {
												const checked = e.target.checked;
												setVisibility((v) => {
													const list = v[kind] ?? categories.map((c) => c.name);
													return {
														...v,
														[kind]: checked
															? [...new Set([...list, row.name])]
															: list.filter((n) => n !== row.name),
													};
												});
											}}
										/>{" "}
										<span>{row.name || "Bez kategorije"}</span>
										<small>{row.count}</small>
									</label>
								))}
						</div>
						{!categories.length && (
							<p>Nema kategorija. Prvo učitajte katalog liste.</p>
						)}
						<button
							className="primary"
							type="button"
							onClick={() => void save()}
						>
							Sačuvaj vidljivost
						</button>
					</fieldset>
				)}
			</dialog>
		</>
	);
}
