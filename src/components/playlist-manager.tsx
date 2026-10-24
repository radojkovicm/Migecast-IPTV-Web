"use client";
import { useId, useState } from "react";
import { MAX_PLAYLIST_BYTES, type PlaylistInput } from "@/lib/playlist-input";
import type { PlaylistInventory, PlaylistSummary } from "@/lib/playlist-types";
import { CategoryManager } from "./category-manager";

async function request<T>(
	path: string,
	method = "GET",
	data?: unknown,
): Promise<T> {
	const response = await fetch(path, {
		method,
		cache: "no-store",
		headers:
			data === undefined ? undefined : { "Content-Type": "application/json" },
		body: data === undefined ? undefined : JSON.stringify(data),
	});
	const result = await response.json();
	if (!response.ok) throw new Error(result.error ?? "Radnja nije uspela.");
	return result as T;
}

export function PlaylistManager({
	initial,
	ownerId,
	selectedUser: requestedUserId,
}: {
	initial: PlaylistInventory;
	ownerId: string;
	selectedUser?: string;
}) {
	const id = useId();
	const initialUserId =
		initial.users.find((u) => u.id === requestedUserId)?.id ?? ownerId;
	const [inventory, setInventory] = useState(initial);
	const [selectedUserId, setSelectedUserId] = useState(initialUserId);
	const [assigned, setAssigned] = useState<string[]>(
		initial.users
			.find((user) => user.id === initialUserId)
			?.playlistAssignments.map((row) => row.playlistId) ?? [],
	);
	const [editing, setEditing] = useState<PlaylistSummary | null>(null);
	const [name, setName] = useState("");
	const [mode, setMode] = useState<"url" | "xtream" | "file">("url");
	const [replace, setReplace] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const selectedUser = inventory.users.find(
		(user) => user.id === selectedUserId,
	);
	const assignedIds =
		selectedUser?.playlistAssignments.map((row) => row.playlistId) ?? [];
	const activeId = selectedUser?.playlistSelection?.playlistId ?? null;
	const dirty =
		assigned.length !== assignedIds.length ||
		assigned.some((value) => !assignedIds.includes(value));

	async function reload() {
		const next = await request<PlaylistInventory>("/api/admin/playlists");
		setInventory(next);
		setAssigned(
			next.users
				.find((user) => user.id === selectedUserId)
				?.playlistAssignments.map((row) => row.playlistId) ?? [],
		);
	}
	async function act(action: () => Promise<unknown>, success: string) {
		setBusy(true);
		setError("");
		setMessage("");
		try {
			await action();
			await reload();
			setMessage(success);
		} catch (error) {
			setMessage("");
			setError(error instanceof Error ? error.message : "Radnja nije uspela.");
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="playlist-manager">
			<div aria-live="polite">
				{message && <p className="notice">{message}</p>}
			</div>
			{error && (
				<div role="alert" className="error">
					<p>{error}</p>
					<button
						type="button"
						disabled={busy}
						onClick={() => act(async () => undefined, "Prikaz je osvežen.")}
					>
						Osveži prikaz
					</button>
				</div>
			)}
			<section className="panel wide">
				<h2>{editing ? "Uredi listu" : "Dodaj listu"}</h2>
				<form
					key={`${editing?.id ?? "new"}-${mode}-${replace}`}
					className="form"
					onSubmit={async (event) => {
						event.preventDefault();
						const element = event.currentTarget;
						const values = new FormData(element);
						await act(
							async () => {
								let input: PlaylistInput | undefined;
								if (!editing || replace) {
									if (mode === "url")
										input = {
											kind: "url",
											url: String(values.get("url") ?? ""),
										};
									else if (mode === "xtream")
										input = {
											kind: "xtream",
											server: String(values.get("server") ?? ""),
											username: String(values.get("username") ?? ""),
											password: String(values.get("password") ?? ""),
										};
									else {
										const file = values.get("file");
										if (!(file instanceof File) || !file.size)
											throw new Error("Izaberite M3U fajl.");
										if (file.size > MAX_PLAYLIST_BYTES)
											throw new Error("Lista može imati najviše 10 MiB.");
										input = { kind: "file", content: await file.text() };
									}
								}
								const saved = await request<PlaylistSummary>(
									editing
										? `/api/admin/playlists/${editing.id}`
										: "/api/admin/playlists",
									editing ? "PATCH" : "POST",
									{
										name,
										input,
										...(editing ? { revision: editing.revision } : {}),
									},
								);
								setEditing(null);
								setName("");
								setReplace(false);
								element.reset();
								if (input) {
									setMessage(
										"Lista je sačuvana. Učitavanje kanala, filmova i serija…",
									);
									// Saving succeeded: retries must refresh this source, not create it again.
									try {
										await reload();
										await request(
											`/api/admin/playlists/${saved.id}/refresh`,
											"POST",
											{
												revision: saved.revision,
											},
										);
									} catch (cause) {
										setMessage("");
										throw new Error(
											`Lista je sačuvana, ali katalog nije učitan. ${cause instanceof Error ? cause.message : "Pokušajte ponovo."} Kliknite „Osveži katalog“ uz sačuvanu listu; nemojte je dodavati ponovo.`,
										);
									}
								}
							},
							editing
								? replace
									? "Lista je sačuvana i katalog je učitan."
									: "Lista je sačuvana."
								: "Lista je sačuvana i katalog je učitan. Dodelite je korisniku, pa izaberite Koristi.",
						);
					}}
				>
					<label htmlFor={`${id}-name`}>Naziv liste</label>
					<input
						id={`${id}-name`}
						value={name}
						onChange={(event) => setName(event.target.value)}
						required
						maxLength={100}
					/>
					{editing && (
						<label className="check">
							<input
								type="checkbox"
								checked={replace}
								onChange={(event) => setReplace(event.target.checked)}
							/>
							Promeni link, fajl ili Xtream podatke
						</label>
					)}
					{(!editing || replace) && (
						<>
							<fieldset disabled={busy}>
								<legend>Način unosa</legend>
								<div className="actions">
									{[
										{ key: "url", label: "Internet adresa" },
										{ key: "file", label: "Fajl" },
										{ key: "xtream", label: "Xtream nalog" },
									].map((option) => (
										<label className="check" key={option.key}>
											<input
												type="radio"
												name="mode"
												value={option.key}
												checked={mode === option.key}
												onChange={() => setMode(option.key as typeof mode)}
											/>
											{option.label}
										</label>
									))}
								</div>
							</fieldset>
							{mode === "url" && (
								<>
									<label htmlFor={`${id}-url`}>M3U ili Xtream link</label>
									<input
										id={`${id}-url`}
										name="url"
										type="url"
										autoComplete="off"
										required
										maxLength={8192}
									/>
								</>
							)}
							{mode === "xtream" && (
								<>
									<label htmlFor={`${id}-server`}>Adresa servera</label>
									<input
										id={`${id}-server`}
										name="server"
										type="url"
										autoComplete="off"
										required
										maxLength={8192}
									/>
									<label htmlFor={`${id}-username`}>
										Xtream korisničko ime
									</label>
									<input
										id={`${id}-username`}
										name="username"
										autoComplete="off"
										required
										maxLength={256}
									/>
									<label htmlFor={`${id}-password`}>Xtream lozinka</label>
									<input
										id={`${id}-password`}
										name="password"
										type="password"
										autoComplete="new-password"
										required
										maxLength={1024}
									/>
								</>
							)}
							{mode === "file" && (
								<>
									<label htmlFor={`${id}-file`}>
										M3U/M3U8 fajl (do 10 MiB)
									</label>
									<input
										id={`${id}-file`}
										name="file"
										type="file"
										accept=".m3u,.m3u8"
										required
									/>
								</>
							)}
						</>
					)}
					<div className="actions">
						<button type="submit" className="primary" disabled={busy}>
							{busy ? "Čuvanje…" : "Sačuvaj listu"}
						</button>
						{editing && (
							<button
								type="button"
								className="quiet"
								disabled={busy}
								onClick={() => {
									setEditing(null);
									setName("");
									setReplace(false);
								}}
							>
								Otkaži
							</button>
						)}
					</div>
				</form>
			</section>
			<section className="panel wide">
				<h2>Sačuvane liste</h2>
				{!inventory.playlists.length && <p>Nema sačuvanih listi.</p>}
				<ul className="source-list">
					{inventory.playlists.map((playlist) => (
						<li key={playlist.id} id={`playlist-${playlist.id}`}>
							<div>
								<strong>{playlist.name}</strong>
								<p className="muted">
									{playlist.kind === "xtream"
										? "Xtream"
										: playlist.kind === "file"
											? "M3U fajl"
											: "M3U link"}
									{playlist.entryCount !== null
										? ` · ${playlist.entryCount} stavki`
										: ""}{" "}
									· Dodeljeno: {playlist._count.assignments}
								</p>
								<small className="muted">
									{playlist.catalogRevision === null
										? "Katalog nije učitan — izaberite Osveži katalog."
										: playlist.catalogRevision !== playlist.revision
											? "Izvor je promenjen — osvežite katalog."
											: `Katalog učitan · ${playlist._count.catalogItems} stavki${playlist.catalogUpdatedAt ? ` · ${new Date(playlist.catalogUpdatedAt).toLocaleString("sr-Latn-RS")}` : ""}`}
									{" · Reprodukcija nije proverena"}
								</small>
							</div>
							<div className="actions">
								<CategoryManager
									playlistId={playlist.id}
									name={playlist.name}
								/>
								<button
									type="button"
									className="quiet"
									disabled={busy}
									onClick={() => {
										if (
											window.confirm(
												"Prekinuti aktivnu reprodukciju ove liste?",
											)
										)
											void act(
												() =>
													request(
														`/api/admin/playlists/${playlist.id}/stop`,
														"POST",
														{},
													),
												"Reprodukcija je prekinuta.",
											);
									}}
								>
									Prekini reprodukciju
								</button>
								<button
									type="button"
									className="quiet"
									disabled={busy}
									onClick={() =>
										void act(
											() =>
												request(
													`/api/admin/playlists/${playlist.id}/refresh`,
													"POST",
													{ revision: playlist.revision },
												),
											"Katalog je učitan.",
										)
									}
								>
									Osveži katalog
								</button>
								<button
									type="button"
									className="quiet"
									disabled={busy}
									onClick={() => {
										setEditing(playlist);
										setName(playlist.name);
										setMode(
											playlist.kind === "xtream"
												? "xtream"
												: playlist.kind === "file"
													? "file"
													: "url",
										);
										setReplace(false);
										setError("");
										window.scrollTo({ top: 0, behavior: "smooth" });
									}}
								>
									Uredi
								</button>
								<button
									type="button"
									className="quiet danger"
									disabled={busy}
									onClick={() => {
										if (
											!window.confirm(
												playlist._count.assignments
													? `Obrisati „${playlist.name}“? Pristup ovoj listi biće uklonjen za ${playlist._count.assignments} korisnika, uključujući aktivni izbor.`
													: `Obrisati „${playlist.name}“?`,
											)
										)
											return;
										act(async () => {
											await request(
												`/api/admin/playlists/${playlist.id}`,
												"DELETE",
												{
													revision: playlist.revision,
													detach: playlist._count.assignments > 0,
												},
											);
											if (editing?.id === playlist.id) {
												setEditing(null);
												setName("");
											}
										}, "Lista je obrisana.");
									}}
								>
									Obriši
								</button>
							</div>
						</li>
					))}
				</ul>
			</section>
			<section className="panel wide" id="assignments">
				<h2>Liste korisnika</h2>
				<p>
					1. Izaberite korisnika. 2. Označite i sačuvajte dodeljene liste. 3.
					Pritisnite „Koristi“ za jednu aktivnu listu.
				</p>
				<label htmlFor={`${id}-user`}>Korisnik</label>
				<select
					id={`${id}-user`}
					value={selectedUserId}
					disabled={busy}
					onChange={(event) => {
						setSelectedUserId(event.target.value);
						setAssigned(
							inventory.users
								.find((user) => user.id === event.target.value)
								?.playlistAssignments.map((row) => row.playlistId) ?? [],
						);
						setError("");
						setMessage("");
					}}
				>
					{inventory.users.map((user) => (
						<option value={user.id} key={user.id}>
							{user.name} ({user.username})
						</option>
					))}
				</select>
				{selectedUser && (
					<>
						<ul className="source-list">
							{inventory.playlists.map((playlist) => (
								<li key={playlist.id}>
									<label className="check">
										<input
											type="checkbox"
											disabled={busy}
											checked={assigned.includes(playlist.id)}
											onChange={(event) =>
												setAssigned(
													event.target.checked
														? [...assigned, playlist.id]
														: assigned.filter((value) => value !== playlist.id),
												)
											}
										/>
										{playlist.name}
									</label>
									<div className="actions">
										{activeId === playlist.id ? (
											<strong className="active-label">Aktivna</strong>
										) : (
											<button
												type="button"
												className="quiet"
												disabled={
													busy || dirty || !assignedIds.includes(playlist.id)
												}
												onClick={() =>
													act(
														() =>
															request(
																`/api/admin/users/${selectedUser.id}/active-playlist`,
																"PUT",
																{
																	playlistId: playlist.id,
																	revision: selectedUser.playlistRevision,
																},
															),
														"Aktivna lista je promenjena.",
													)
												}
											>
												Koristi
											</button>
										)}
									</div>
								</li>
							))}
						</ul>
						<div className="actions">
							<button
								type="button"
								className="primary"
								disabled={busy || !dirty}
								onClick={() => {
									const deactivate = !!activeId && !assigned.includes(activeId);
									if (
										deactivate &&
										!window.confirm(
											"Uklanjate aktivnu listu. Korisnik će ostati bez aktivne liste. Nastaviti?",
										)
									)
										return;
									act(
										() =>
											request(
												`/api/admin/users/${selectedUser.id}/playlists`,
												"PUT",
												{
													playlistIds: assigned,
													revision: selectedUser.playlistRevision,
													deactivate,
												},
											),
										"Dodela je sačuvana.",
									);
								}}
							>
								Sačuvaj dodelu
							</button>
							{activeId && (
								<button
									type="button"
									className="quiet"
									disabled={busy || dirty}
									onClick={() => {
										if (window.confirm("Deaktivirati listu za ovog korisnika?"))
											act(
												() =>
													request(
														`/api/admin/users/${selectedUser.id}/active-playlist`,
														"PUT",
														{
															playlistId: null,
															revision: selectedUser.playlistRevision,
														},
													),
												"Lista je deaktivirana.",
											);
									}}
								>
									Deaktiviraj
								</button>
							)}
						</div>
					</>
				)}
			</section>
		</div>
	);
}
