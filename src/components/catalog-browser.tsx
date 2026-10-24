"use client";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import "./catalog-browser.css";
import { MediaPlayer, type PlaybackProgress } from "./media-player";

type Item = {
	id: string;
	kind: string;
	title: string;
	category: string;
	season: number | null;
	episode: number | null;
	favorite: boolean;
	position: number;
	duration: number;
	completed: boolean;
};
type Details = {
	title: string;
	description: string | null;
	genre: string | null;
	year: string | null;
	durationSeconds: number | null;
	rating: string | null;
	cast: string | null;
	director: string | null;
};
type Catalog = {
	items: Item[];
	categories: string[];
	total: number;
	ready: boolean;
	sourceName: string;
};
export function CatalogBrowser({ kind }: { kind: string }) {
	const [catalog, setCatalog] = useState<Catalog | null>(null);
	const [query, setQuery] = useState("");
	const [search, setSearch] = useState("");
	const [category, setCategory] = useState("");
	const [page, setPage] = useState(0);
	const [retry, setRetry] = useState(0);
	const catalogKey = useRef("");
	const loadMore = useRef<HTMLDivElement>(null);
	const channelList = useRef<HTMLDivElement>(null);
	const tvWorkspace = useRef<HTMLDivElement>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [series, setSeries] = useState<Item | null>(null);
	const [episodes, setEpisodes] = useState<Item[]>([]);
	const [playing, setPlaying] = useState<Item | null>(null);
	const [favorites, setFavorites] = useState(true);
	const [editingOrder, setEditingOrder] = useState(false);
	const [orderMessage, setOrderMessage] = useState("");
	const [saving, setSaving] = useState<string | null>(null);
	const [refresh, setRefresh] = useState(0);
	const [autoNext, setAutoNext] = useState(true);
	const [playKey, setPlayKey] = useState(0);
	const [season, setSeason] = useState("");
	const [detailItem, setDetailItem] = useState<Item | null>(null);
	const [details, setDetails] = useState<Details | null>(null);
	const [detailsLoading, setDetailsLoading] = useState(false);
	const [detailsError, setDetailsError] = useState("");
	const detailsDialog = useRef<HTMLDialogElement>(null);
	const playerDialog = useRef<HTMLDialogElement>(null);
	const detailId = detailItem?.id;
	useEffect(() => {
		if (!detailId) return;
		const controller = new AbortController();
		setDetails(null);
		setDetailsError("");
		setDetailsLoading(true);
		void fetch(`/api/catalog/${detailId}/details`, {
			signal: controller.signal,
		})
			.then(async (response) => {
				if (!response.ok) throw new Error();
				setDetails(await response.json());
			})
			.catch(() => {
				if (!controller.signal.aborted)
					setDetailsError(
						"Opis trenutno nije dostupan. Reprodukciju možete pokrenuti.",
					);
			})
			.finally(() => {
				if (!controller.signal.aborted) setDetailsLoading(false);
			});
		return () => controller.abort();
	}, [detailId]);
	function openDetails(item: Item) {
		flushSync(() => {
			setDetails(null);
			setDetailsError("");
			setDetailsLoading(true);
			setDetailItem(item);
			setSeries(item.kind === "series" ? item : null);
		});
		detailsDialog.current?.showModal();
	}
	function closeDetails() {
		detailsDialog.current?.close();
		setDetailItem(null);
		setSeries(null);
		setError("");
	}
	function closePlayer() {
		if (
			document.fullscreenElement &&
			playerDialog.current?.contains(document.fullscreenElement)
		)
			void document.exitFullscreen().catch(() => {});
		playerDialog.current?.close();
		setPlaying(null);
		if (detailItem && !detailsDialog.current?.open)
			detailsDialog.current?.showModal();
	}
	function chooseCategory(value: string) {
		setEditingOrder(false);
		setOrderMessage("");
		setFavorites(value === "__favorites__");
		setCategory(value === "__favorites__" ? "" : value);
		setPage(0);
	}
	useEffect(() => {
		if (query === search) return;
		const timer = setTimeout(() => {
			setSearch(query);
			setPage(0);
		}, 250);
		return () => clearTimeout(timer);
	}, [query, search]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Refresh re-fetches a filtered page after a favorite mutation.
	useEffect(() => {
		const key = JSON.stringify([kind, search, category, favorites, refresh]);
		const changed = catalogKey.current !== key;
		if (changed && page !== 0) {
			setPage(0);
			return;
		}
		catalogKey.current = key;
		const controller = new AbortController();
		if (changed) setCatalog(null);
		setLoading(true);
		setError("");
		void fetch(
			`/api/catalog?${new URLSearchParams({ kind, q: search, category, page: String(page), favorites: favorites ? "1" : "0" })}`,
			{ signal: controller.signal },
		)
			.then(async (response) => {
				const data = await response.json();
				if (!response.ok) throw new Error(data.error);
				if (controller.signal.aborted) return;
				setCatalog((current) =>
					page > 0 && current
						? {
								...data,
								items: Array.from(
									new Map(
										[...current.items, ...data.items].map((item: Item) => [
											item.id,
											item,
										]),
									).values(),
								),
							}
						: data,
				);
			})
			.catch((error) => {
				if (!controller.signal.aborted) setError(error.message);
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [kind, search, category, page, favorites, refresh, retry]);
	useEffect(() => {
		if (
			loading ||
			error ||
			!catalog?.ready ||
			catalog.items.length >= catalog.total
		)
			return;
		const node = loadMore.current;
		if (!node) return;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting) {
					observer.disconnect();
					setLoading(true);
					setPage((current) => current + 1);
				}
			},
			{ root: kind === "tv" ? channelList.current : null, rootMargin: "600px" },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [kind, loading, error, catalog]);
	useEffect(() => {
		if (!series) return;
		const controller = new AbortController();
		setEpisodes([]);
		setSeason("");
		setError("");
		setLoading(true);
		void fetch(`/api/catalog/${series.id}/episodes`, {
			signal: controller.signal,
		})
			.then(async (r) => {
				const data = await r.json();
				if (!r.ok) throw new Error(data.error);
				setEpisodes(data.items);
				setSeason(data.items.length ? String(data.items[0].season) : "");
			})
			.catch((error) => {
				if (!controller.signal.aborted) setError(error.message);
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [series]);
	function updateItem(id: string, changes: Partial<Item>) {
		setDetailItem((current) =>
			current?.id === id ? { ...current, ...changes } : current,
		);
		setCatalog((current) =>
			current
				? {
						...current,
						items: current.items.map((item) =>
							item.id === id ? { ...item, ...changes } : item,
						),
					}
				: null,
		);
		setEpisodes((current) =>
			current.map((item) => (item.id === id ? { ...item, ...changes } : item)),
		);
	}
	function play(item: Item, restart = false) {
		const update = () => {
			setPlaying(restart ? { ...item, position: 0 } : item);
			setPlayKey((key) => key + 1);
		};
		if (kind === "tv") {
			update();
			return;
		}
		flushSync(update);
		detailsDialog.current?.close();
		const dialog = playerDialog.current;
		if (!dialog) return;
		if (!dialog.open) dialog.showModal();
		if (
			document.fullscreenEnabled &&
			(!document.fullscreenElement ||
				document.fullscreenElement === document.documentElement)
		)
			void dialog
				.querySelector<HTMLElement>(".vod-player-surface")
				?.requestFullscreen()
				.catch(() => {
					/* The viewport dialog remains visible if the browser denies native fullscreen. */
				});
	}
	async function moveFavorite(index: number, direction: -1 | 1) {
		if (!catalog || saving) return;
		const item = catalog.items[index];
		const neighbor = catalog.items[index + direction];
		if (!item || !neighbor) return;
		setSaving(item.id);
		setError("");
		setOrderMessage("");
		try {
			const response = await fetch("/api/catalog/favorite-order", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					itemId: item.id,
					neighborId: neighbor.id,
					direction,
				}),
			});
			const result = await response.json();
			if (!response.ok)
				throw new Error(result.error ?? "Redosled nije sačuvan.");
			setCatalog((current) => {
				if (!current) return current;
				const reordered = [...current.items];
				const from = reordered.findIndex((entry) => entry.id === item.id);
				const to = reordered.findIndex((entry) => entry.id === neighbor.id);
				if (from < 0 || to < 0) return current;
				[reordered[from], reordered[to]] = [reordered[to], reordered[from]];
				return { ...current, items: reordered };
			});
			setOrderMessage("Redosled je sačuvan.");
		} catch (error) {
			setError(
				error instanceof Error
					? error.message
					: "Redosled nije sačuvan. Proverite vezu.",
			);
		} finally {
			setSaving(null);
		}
	}
	async function favorite(item: Item) {
		setSaving(item.id);
		setError("");
		try {
			const response = await fetch(`/api/catalog/${item.id}/favorite`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ favorite: !item.favorite }),
			});
			if (!response.ok) throw new Error("Omiljeni sadržaj nije sačuvan.");
			updateItem(item.id, { favorite: !item.favorite });
			if (favorites) setRefresh((value) => value + 1);
		} catch (error) {
			setError(error instanceof Error ? error.message : "Čuvanje nije uspelo.");
		} finally {
			setSaving(null);
		}
	}
	async function progress(item: Item, data: PlaybackProgress) {
		if (!["movie", "episode"].includes(item.kind)) return;
		try {
			const response = await fetch(`/api/playback/${data.leaseId}/progress`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					itemId: item.id,
					position: data.position,
					duration: data.duration,
					completed: data.completed,
				}),
				keepalive: true,
				signal: AbortSignal.timeout(5000),
			});
			if (!response.ok) {
				if (response.status !== 410)
					setError("Pozicija gledanja nije sačuvana.");
				return;
			}
			const saved = await response.json();
			updateItem(item.id, {
				position: saved.completed ? 0 : saved.position,
				duration: saved.duration,
				completed: saved.completed,
			});
		} catch {
			setError("Pozicija gledanja nije sačuvana. Proverite vezu.");
		}
	}
	function nextEpisode() {
		if (!autoNext || playing?.kind !== "episode") return;
		const next =
			episodes[episodes.findIndex((item) => item.id === playing.id) + 1];
		if (next) play(next, true);
	}
	const items = catalog?.items ?? [];
	const selectedEpisodes = episodes.filter(
		(item) => !season || String(item.season) === season,
	);
	if (kind === "tv")
		return (
			<div className="tv-workspace" ref={tvWorkspace}>
				<aside className="channel-sidebar" aria-label="TV kanali">
					<div className="channel-filters">
						<label>
							<span className="sr-only">Kategorija</span>
							<select
								value={favorites ? "__favorites__" : category}
								onChange={(event) => {
									chooseCategory(event.target.value);
								}}
							>
								<option value="">Svi kanali</option>
								<option value="__favorites__">★ Omiljeni</option>
								{catalog?.categories.map((value) => (
									<option key={value}>{value}</option>
								))}
							</select>
						</label>
						<label>
							<span className="sr-only">Pretraga</span>
							<input
								type="search"
								placeholder="Pretražite kanale…"
								value={query}
								disabled={editingOrder}
								onChange={(event) => setQuery(event.target.value)}
							/>
						</label>
					</div>
					{favorites && items.length > 1 && !query && !search && (
						<div className="favorite-order-toolbar">
							<button
								type="button"
								disabled={saving !== null}
								aria-pressed={editingOrder}
								onClick={() => {
									setEditingOrder(!editingOrder);
									setOrderMessage("");
								}}
							>
								{editingOrder ? "Gotovo" : "Uredi redosled"}
							</button>
							{editingOrder && (
								<small>
									Pomerite kanal strelicama. Promene se čuvaju odmah.
								</small>
							)}
						</div>
					)}
					{editingOrder && (
						<p className="sr-only" role="status">
							{orderMessage}
						</p>
					)}
					{error && <p role="alert">{error}</p>}
					{loading && <p role="status">Učitavanje…</p>}
					{!loading && !error && !items.length && (
						<p className="channel-empty">
							{catalog?.ready
								? favorites
									? "Još nema omiljenih kanala. Izaberite kategoriju i označite zvezdicu."
									: "Nema kanala za ovaj izbor."
								: "Administrator treba da učita katalog liste."}
						</p>
					)}
					<div className="channel-list" ref={channelList}>
						{items.map((item, index) => (
							<div
								className={`channel-row ${playing?.id === item.id ? "selected" : ""}`}
								key={item.id}
							>
								<button
									type="button"
									className="channel-choice"
									disabled={editingOrder}
									aria-label={item.title}
									aria-pressed={playing?.id === item.id}
									onClick={() => {
										if (playing?.id !== item.id) play(item);
									}}
									onDoubleClick={() => {
										if (playing?.id !== item.id) flushSync(() => play(item));
										void tvWorkspace.current
											?.querySelector<HTMLElement>(".cinema-player")
											?.dispatchEvent(new CustomEvent("migecast:fullscreen"));
									}}
								>
									<span className="channel-number" aria-hidden="true">
										{index + 1}
										{/* biome-ignore lint/performance/noImgElement: Provider artwork requires session authorization. */}
										<img
											src={`/api/catalog/${item.id}/art`}
											alt=""
											loading="lazy"
											onError={(event) => {
												event.currentTarget.style.display = "none";
											}}
										/>
									</span>
									<span className="channel-title">{item.title}</span>
								</button>
								{editingOrder && (
									<div className="favorite-order-actions">
										<button
											type="button"
											aria-label={`Pomeri gore: ${item.title}`}
											title="Pomeri gore"
											disabled={saving !== null || loading || index === 0}
											onClick={() => void moveFavorite(index, -1)}
										>
											↑
										</button>
										<button
											type="button"
											aria-label={`Pomeri dole: ${item.title}`}
											title="Pomeri dole"
											disabled={
												saving !== null || loading || index === items.length - 1
											}
											onClick={() => void moveFavorite(index, 1)}
										>
											↓
										</button>
									</div>
								)}
								<button
									type="button"
									className={`channel-star favorite-star ${item.favorite ? "is-favorite" : ""}`}
									aria-label={`${item.favorite ? "Ukloni iz omiljenih" : "Dodaj u omiljene"}: ${item.title}`}
									aria-pressed={item.favorite}
									disabled={saving !== null || editingOrder}
									onClick={() => void favorite(item)}
								>
									{item.favorite ? "★" : "☆"}
								</button>
							</div>
						))}
						<div
							ref={loadMore}
							className="catalog-load-more"
							aria-live="polite"
						>
							{loading && items.length > 0 && <p>Učitavanje još kanala…</p>}
							{error && (
								<button
									type="button"
									onClick={() => setRetry((value) => value + 1)}
								>
									Pokušaj ponovo
								</button>
							)}
						</div>
					</div>
				</aside>
				<section className="tv-screen" aria-label="Televizija">
					{playing ? (
						<>
							<h2 className="now-playing">{playing.title}</h2>
							<MediaPlayer
								key={`${playing.id}:${playKey}`}
								itemId={playing.id}
								title={playing.title}
								onClose={() => setPlaying(null)}
							/>
						</>
					) : (
						<div className="tv-placeholder">
							<svg
								width="64"
								height="64"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.3"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<rect x="3" y="4" width="18" height="13" rx="3" />
								<path d="M8 21h8 M12 17v4 M10 8l5 3-5 3z" />
							</svg>
							<p>Izaberite kanal iz liste</p>
						</div>
					)}
				</section>
			</div>
		);
	return (
		<>
			<dialog
				ref={playerDialog}
				className="vod-player-dialog"
				aria-label="Reprodukcija"
				onCancel={(event) => {
					event.preventDefault();
					closePlayer();
				}}
			>
				<div className="vod-player-surface">
					{playing && (
						<MediaPlayer
							key={`${playing.id}:${playKey}`}
							itemId={playing.id}
							title={playing.title}
							initialPosition={playing.position}
							onProgress={(data) => progress(playing, data)}
							onEnded={nextEpisode}
							onClose={closePlayer}
						/>
					)}
				</div>
			</dialog>
			<dialog
				ref={detailsDialog}
				className="media-details-dialog"
				aria-labelledby="media-details-title"
				onCancel={(event) => {
					event.preventDefault();
					closeDetails();
				}}
			>
				{detailItem && (
					<>
						<button
							className="detail-close"
							type="button"
							aria-label="Zatvori detalje"
							title="Zatvori"
							onClick={closeDetails}
						>
							×
						</button>
						<div className="media-detail-summary">
							{/* biome-ignore lint/performance/noImgElement: Artwork is protected by the viewer session. */}
							<img
								key={detailItem.id}
								className="detail-poster"
								src={`/api/catalog/${detailItem.id}/art`}
								alt=""
								onError={(event) => {
									event.currentTarget.style.visibility = "hidden";
								}}
							/>
							<div className="detail-copy">
								<p className="detail-kind">
									{detailItem.kind === "series" ? "Serija" : "Film"}
								</p>
								<h2 id="media-details-title">{detailItem.title}</h2>
								<div className="detail-meta">
									{details?.year && <span>{details.year}</span>}
									{details?.genre && <span>{details.genre}</span>}
									{!!details?.durationSeconds && (
										<span>{Math.round(details.durationSeconds / 60)} min</span>
									)}
									{details?.rating && <span>★ {details.rating}</span>}
								</div>
								{detailsLoading ? (
									<p role="status">Učitavanje opisa…</p>
								) : (
									<p className="detail-description">
										{detailsError ||
											details?.description ||
											"Opis nije dostupan u ovoj listi."}
									</p>
								)}
								{details?.cast && (
									<p className="detail-credits">
										<strong>Uloge</strong> {details.cast}
									</p>
								)}
								{details?.director && (
									<p className="detail-credits">
										<strong>Režija</strong> {details.director}
									</p>
								)}
								<div className="detail-actions">
									{detailItem.kind === "movie" && (
										<button
											className="primary"
											type="button"
											onClick={() => play(detailItem)}
										>
											<span aria-hidden="true">▶</span>{" "}
											{detailItem.position >= 1
												? "Nastavi gledanje"
												: "Pusti film"}
										</button>
									)}
									{detailItem.kind === "movie" && detailItem.position >= 1 && (
										<button
											className="quiet"
											type="button"
											aria-label={`Od početka: ${detailItem.title}`}
											onClick={() => play(detailItem, true)}
										>
											Od početka
										</button>
									)}
									<button
										type="button"
										className={`favorite-star ${detailItem.favorite ? "is-favorite" : ""}`}
										aria-label={`${detailItem.favorite ? "Ukloni iz omiljenih" : "Dodaj u omiljene"}: ${detailItem.title}`}
										aria-pressed={detailItem.favorite}
										disabled={saving !== null}
										onClick={() => void favorite(detailItem)}
									>
										{detailItem.favorite ? "★" : "☆"}
									</button>
								</div>
							</div>
						</div>
						{series && (
							<section
								className="series-episodes"
								aria-label="Sezone i epizode"
							>
								<div className="season-toolbar">
									<label>
										Sezona
										<select
											value={season}
											onChange={(event) => setSeason(event.target.value)}
										>
											{[...new Set(episodes.map((item) => item.season))].map(
												(value) => (
													<option key={String(value)} value={String(value)}>
														Sezona {value ?? 0}
													</option>
												),
											)}
										</select>
									</label>
									<label className="inline-check">
										<input
											type="checkbox"
											checked={autoNext}
											onChange={(event) => setAutoNext(event.target.checked)}
										/>
										Sledeća epizoda automatski
									</label>
								</div>
								{loading && <p role="status">Učitavanje epizoda…</p>}
								{error && <p role="alert">{error}</p>}
								{!loading && !error && !selectedEpisodes.length && (
									<p>Epizode nisu dostupne u ovoj listi.</p>
								)}
								<div className="episode-list">
									{selectedEpisodes.map((item) => (
										<div className="episode-row" key={item.id}>
											<button
												className="episode-play"
												type="button"
												aria-label={item.title}
												onClick={() => play(item)}
											>
												<span className="episode-number">
													{String(item.episode ?? 0).padStart(2, "0")}
												</span>
												<span className="episode-info">
													<strong>{item.title}</strong>
													<small>
														{item.completed
															? "Odgledano"
															: item.position >= 1
																? `Nastavi od ${Math.floor(item.position / 60)}. minuta`
																: `Sezona ${item.season ?? 0} · Epizoda ${item.episode ?? 0}`}
													</small>
												</span>
												<span className="episode-play-icon" aria-hidden="true">
													▶
												</span>
											</button>
											<button
												type="button"
												className={`favorite-star ${item.favorite ? "is-favorite" : ""}`}
												aria-label={`${item.favorite ? "Ukloni iz omiljenih" : "Dodaj u omiljene"}: ${item.title}`}
												aria-pressed={item.favorite}
												disabled={saving !== null}
												onClick={() => void favorite(item)}
											>
												{item.favorite ? "★" : "☆"}
											</button>
										</div>
									))}
								</div>
							</section>
						)}
					</>
				)}
			</dialog>
			<div className="catalog-tools library-filters">
				<label>
					Pretraga
					<input
						type="search"
						placeholder={
							kind === "movie" ? "Pretražite filmove…" : "Pretražite serije…"
						}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</label>
				<label>
					Kategorija
					<select
						value={favorites ? "__favorites__" : category}
						onChange={(event) => chooseCategory(event.target.value)}
					>
						<option value="">
							{kind === "movie" ? "Svi filmovi" : "Sve serije"}
						</option>
						<option value="__favorites__">★ Omiljeni</option>
						{catalog?.categories.map((value) => (
							<option key={value}>{value}</option>
						))}
					</select>
				</label>
			</div>
			{error && !series && <p role="alert">{error}</p>}
			{loading && !series && !items.length && <p role="status">Učitavanje…</p>}
			{!loading && !error && !items.length && (
				<p>
					{catalog?.ready
						? favorites
							? "Još nema omiljenih naslova. Izaberite kategoriju i označite zvezdicu."
							: "Nema sadržaja za ovaj izbor."
						: "Administrator treba da učita katalog liste."}
				</p>
			)}
			<div className="catalog-grid">
				{items.map((item) => (
					<div className="catalog-entry" key={item.id}>
						<button
							className="catalog-card"
							type="button"
							aria-label={item.title}
							onClick={() => openDetails(item)}
						>
							{/* biome-ignore lint/performance/noImgElement: Artwork is protected by the viewer session. */}
							<img
								src={`/api/catalog/${item.id}/art`}
								alt=""
								loading="lazy"
								onError={(event) => {
									event.currentTarget.style.visibility = "hidden";
								}}
							/>
							<span>{item.title}</span>
						</button>
						<div className="catalog-actions">
							<button
								type="button"
								className={`favorite-star ${item.favorite ? "is-favorite" : ""}`}
								aria-label={`${item.favorite ? "Ukloni iz omiljenih" : "Dodaj u omiljene"}: ${item.title}`}
								aria-pressed={item.favorite}
								disabled={saving !== null}
								onClick={() => void favorite(item)}
							>
								{item.favorite ? "★" : "☆"}
							</button>
							{item.position >= 1 && (
								<small>
									Nastavi od {Math.floor(item.position / 60)}. minuta
								</small>
							)}
							{item.completed && <small>Odgledano</small>}
						</div>
					</div>
				))}
			</div>
			<div ref={loadMore} className="catalog-load-more" aria-live="polite">
				{loading && items.length > 0 && <p>Učitavanje još naslova…</p>}
				{error && (
					<button
						type="button"
						className="quiet"
						onClick={() => setRetry((value) => value + 1)}
					>
						Pokušaj ponovo
					</button>
				)}
			</div>
		</>
	);
}
