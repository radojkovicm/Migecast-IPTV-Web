"use client";
import type Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import "./media-player.css";
import { captionTracks, selectCaptionTrack, trackLabel } from "./media-tracks";

// Serialize starts in this tab so a slow, abandoned channel cannot replace a newer one.
let pendingStart: Promise<unknown> = Promise.resolve();
type PlaybackOptions = {
	mode: "auto" | "compatible";
	offset: number;
	resumePosition?: number;
	audioIndex?: number;
	subtitleIndex?: number;
};
type WorkerInfo = {
	duration: number | null;
	offset: number;
	audioIndex: number | null;
	audioTracks: { index: number; language: string }[];
	subtitleIndex: number | null;
	subtitleTracks: { index: number; language: string }[];
};
function requestPlayback(
	itemId: string,
	options: PlaybackOptions,
	isDisposed: () => boolean,
) {
	const operation = pendingStart.then(async () => {
		if (isDisposed()) return null;
		const response = await fetch("/api/playback", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ itemId, ...options }),
		});
		const data = await response.json();
		if (!response.ok)
			throw new Error(data.error ?? "Reprodukcija nije uspela.");
		if (isDisposed()) {
			await fetch(`/api/playback/${data.id}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				keepalive: true,
			}).catch(() => {});
			return null;
		}
		return data;
	});
	pendingStart = operation.catch(() => {});
	return operation;
}
export type PlaybackProgress = {
	position: number;
	duration: number;
	leaseId: string;
	completed?: boolean;
};
export function MediaPlayer({
	itemId,
	onClose,
	initialPosition = 0,
	onProgress,
	onEnded,
	title,
}: {
	itemId: string;
	onClose: () => void;
	initialPosition?: number;
	onProgress?: (progress: PlaybackProgress) => void | Promise<void>;
	onEnded?: () => void;
	title?: string;
}) {
	const video = useRef<HTMLVideoElement>(null);
	const panel = useRef<HTMLElement>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [isMuted, setIsMuted] = useState(false);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [viewportFullscreen, setViewportFullscreen] = useState(false);
	const isVod = !!onProgress;
	const [controlError, setControlError] = useState("");
	const liveRef = useRef(true);
	const callbacks = useRef({ onProgress, onEnded });
	callbacks.current = { onProgress, onEnded };
	const hlsRef = useRef<Hls | null>(null);
	const [audioTracks, setAudioTracks] = useState<
		{ index: number; label: string }[]
	>([]);
	const [subtitleTracks, setSubtitleTracks] = useState<
		{ index: number; label: string }[]
	>([]);
	const [audioTrack, setAudioTrack] = useState(-1);
	const [subtitleTrack, setSubtitleTrack] = useState(-1);
	const [options, setOptions] = useState<PlaybackOptions>({
		mode: "auto",
		offset: 0,
		resumePosition: initialPosition,
	});
	const [worker, setWorker] = useState<WorkerInfo | null>(null);
	const [position, setPosition] = useState(0);
	const [duration, setDuration] = useState(0);
	const [seek, setSeek] = useState<number | null>(null);
	const dragging = useRef(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [controlsVisible, setControlsVisible] = useState(true);
	const [interaction, setInteraction] = useState(0);
	const [fit, setFit] = useState(true);
	const videoClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [volume, setVolume] = useState(1);
	const wakeControls = () => {
		setControlsVisible(true);
		setInteraction((value) => value + 1);
	};
	const totalDuration = worker?.duration ?? duration;
	const seekTo = (value: number) => {
		if (liveRef.current || !totalDuration) return;
		const target = Math.max(0, Math.min(value, totalDuration - 1));
		setPosition(target);
		setSeek(null);
		if (worker)
			setOptions((current) => ({
				...current,
				offset: target,
				resumePosition: 0,
			}));
		else if (video.current) video.current.currentTime = target;
		wakeControls();
	};
	const cancelVideoClick = () => {
		if (videoClickTimer.current) clearTimeout(videoClickTimer.current);
		videoClickTimer.current = null;
	};
	const togglePlay = async () => {
		cancelVideoClick();
		const element = video.current;
		if (!element) return;
		setControlError("");
		if (!element.paused) element.pause();
		else
			try {
				await element.play();
			} catch {
				setControlError("Video još nije spreman. Pokušajte ponovo.");
			}
		wakeControls();
	};
	const toggleFullscreen = async (closeVod = false) => {
		cancelVideoClick();
		setControlError("");
		try {
			if (isVod && closeVod) {
				onClose();
				return;
			}
			if (viewportFullscreen) {
				setViewportFullscreen(false);
				return;
			}
			if (
				document.fullscreenElement &&
				document.fullscreenElement !== document.documentElement &&
				panel.current &&
				document.fullscreenElement.contains(panel.current)
			)
				await document.exitFullscreen();
			else if (document.fullscreenEnabled && panel.current?.requestFullscreen)
				await (
					panel.current.closest(".vod-player-surface") ?? panel.current
				).requestFullscreen();
			else setViewportFullscreen(true);
		} catch {
			// Keep an accessible in-page fullscreen when the browser rejects native fullscreen.
			setViewportFullscreen(true);
		}
		wakeControls();
	};

	useEffect(() => {
		const element = panel.current;
		const expand = () => void toggleFullscreen();
		element?.addEventListener("migecast:fullscreen", expand);
		return () => element?.removeEventListener("migecast:fullscreen", expand);
	});
	useEffect(() => {
		if (!isFullscreen || !window.matchMedia("(pointer: coarse)").matches)
			return;
		const orientation = screen.orientation as ScreenOrientation & {
			lock?: (value: "landscape") => Promise<void>;
		};
		// Unsupported/denied orientation locks use the rotated player canvas below.
		void orientation?.lock?.("landscape").catch(() => {});
		return () => orientation?.unlock?.();
	}, [isFullscreen]);
	useEffect(() => {
		if (!viewportFullscreen) return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		const exitViewport = (event: KeyboardEvent) => {
			if (event.key === "Escape") setViewportFullscreen(false);
		};
		document.addEventListener("keydown", exitViewport);
		return () => {
			document.body.style.overflow = previous;
			document.removeEventListener("keydown", exitViewport);
		};
	}, [viewportFullscreen]);

	useEffect(() => {
		// A delayed click must not pause a newly selected item or an unmounted player.
		void itemId;
		return () => {
			if (videoClickTimer.current) clearTimeout(videoClickTimer.current);
			videoClickTimer.current = null;
		};
	}, [itemId]);
	useEffect(() => {
		void interaction; // Restart the idle timer after each interaction.
		if (!isPlaying || settingsOpen || dragging.current) return;
		const timer = setTimeout(() => setControlsVisible(false), 3000);
		return () => clearTimeout(timer);
	}, [isPlaying, settingsOpen, interaction]);
	const [busy, setBusy] = useState(true);
	const [message, setMessage] = useState("Pokretanje…");
	useEffect(() => {
		const element = video.current;
		if (!element) return;
		const syncPlayback = () => setIsPlaying(!element.paused && !element.ended);
		const syncVolume = () => {
			setIsMuted(element.muted || element.volume === 0);
			setVolume(element.volume);
		};
		const syncDuration = () => {
			if (Number.isFinite(element.duration)) setDuration(element.duration);
		};
		const syncFullscreen = () =>
			setIsFullscreen(
				!!document.fullscreenElement &&
					document.fullscreenElement !== document.documentElement &&
					!!panel.current &&
					document.fullscreenElement.contains(panel.current),
			);
		syncPlayback();
		syncVolume();
		syncFullscreen();

		for (const event of ["play", "pause", "ended", "emptied"])
			element.addEventListener(event, syncPlayback);
		element.addEventListener("volumechange", syncVolume);
		element.addEventListener("durationchange", syncDuration);
		document.addEventListener("fullscreenchange", syncFullscreen);
		return () => {
			for (const event of ["play", "pause", "ended", "emptied"])
				element.removeEventListener(event, syncPlayback);
			element.removeEventListener("volumechange", syncVolume);
			element.removeEventListener("durationchange", syncDuration);
			document.removeEventListener("fullscreenchange", syncFullscreen);
		};
	}, []);
	useEffect(() => {
		let disposed = false;
		setAudioTracks([]);
		setSubtitleTracks([]);
		setAudioTrack(-1);
		setSubtitleTrack(-1);
		setBusy(true);
		setMessage("Pokretanje…");
		const currentWorker: { value: WorkerInfo | null } = { value: null };
		let failed = false;
		let leaseId: string | undefined;
		let hls: Hls | undefined;
		let timer: ReturnType<typeof setInterval> | undefined;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let retries = 0;
		let recovered = false;
		let direct = false;
		let live = true;
		let resumePosition = 0;
		let lastProgressAt = 0;
		let completedPlayback = false;
		let pausedAt = 0;
		let pausedPosition = 0;
		let pendingProgress: Promise<void> = Promise.resolve();
		const element = video.current;
		if (!element) return;
		const started = performance.now();
		const release = (id: string) => {
			const operation = pendingStart
				.then(() => pendingProgress)
				.then(() =>
					fetch(`/api/playback/${id}`, {
						method: "DELETE",
						headers: { "Content-Type": "application/json" },
						keepalive: true,
					}).catch(() => {}),
				);
			pendingStart = operation;
			return operation;
		};
		const reportProgress = (force = false, completed = false) => {
			if (!leaseId || live || !element.readyState) return;
			const duration = currentWorker.value?.duration ?? element.duration;
			const position = (currentWorker.value?.offset ?? 0) + element.currentTime;
			if (
				!Number.isFinite(duration) ||
				duration <= 0 ||
				!Number.isFinite(position)
			)
				return;
			if (!force && performance.now() - lastProgressAt < 10000) return;
			lastProgressAt = performance.now();
			const progressLeaseId = leaseId;
			const progressCallback = callbacks.current.onProgress;
			const isCompleted = completed || completedPlayback;
			pendingProgress = pendingProgress
				.then(() =>
					progressCallback?.({
						position: Math.min(position, duration),
						duration,
						leaseId: progressLeaseId,
						completed: isCompleted,
					}),
				)
				.catch(() => {});
		};
		const stop = () => {
			reportProgress(true);
			hlsRef.current = null;
			hls?.destroy();
			element.pause();
			element.removeAttribute("src");
			delete element.dataset.startupMs;
			element.load();
			if (timer) clearInterval(timer);
			if (retryTimer) clearTimeout(retryTimer);
			if (leaseId) {
				void release(leaseId);
				leaseId = undefined;
			}
		};
		const fail = (text: string) => {
			if (disposed) return;
			failed = true;
			setBusy(false);
			setMessage(text);
			stop();
		};
		const play = () => {
			if (!disposed)
				void element.play().catch(() => {
					if (!disposed && !failed)
						setMessage("Pritisnite reprodukciju u plejeru.");
				});
		};
		const playing = () => {
			setBusy(false);
			if (!disposed) {
				setMessage("");
				if (!element.dataset.startupMs)
					element.dataset.startupMs = String(
						Math.round(performance.now() - started),
					);
			}
		};
		const waiting = () => {
			if (!disposed) setMessage("Učitavanje…");
		};
		const error = () => {
			if (direct && element.error)
				fail(
					"Pregledač ne može da pusti ovaj izvor. Zatvorite i pokušajte ponovo.",
				);
		};
		const syncNativeTracks = () => {
			if (disposed || hls) return;
			const tracks = captionTracks(element.textTracks);
			setSubtitleTracks(tracks.map(({ index, label }) => ({ index, label })));
			setSubtitleTrack(
				tracks.find((track) => track.mode === "showing")?.index ?? -1,
			);
		};
		element.textTracks.addEventListener("addtrack", syncNativeTracks);
		element.textTracks.addEventListener("removetrack", syncNativeTracks);
		element.textTracks.addEventListener("change", syncNativeTracks);
		const resume = () => {
			if (
				!resumePosition ||
				live ||
				currentWorker.value ||
				!Number.isFinite(element.duration)
			)
				return;
			element.currentTime = Math.min(
				resumePosition,
				Math.max(0, element.duration - 1),
			);
			resumePosition = 0;
		};
		const paused = () => {
			reportProgress(true);
			if (
				!disposed &&
				!failed &&
				currentWorker.value?.duration &&
				!element.ended
			) {
				pausedAt = Date.now();
				pausedPosition = currentWorker.value.offset + element.currentTime;
			}
		};
		const resetCompleted = () => {
			if (
				Number.isFinite(element.duration) &&
				element.currentTime < element.duration - 1
			)
				completedPlayback = false;
		};
		const resumed = () => {
			resetCompleted();
			if (
				!disposed &&
				currentWorker.value?.duration &&
				pausedAt &&
				Date.now() - pausedAt > 10000
			) {
				setOptions({
					...options,
					offset: Math.min(
						pausedPosition,
						Math.max(0, currentWorker.value.duration - 1),
					),
					resumePosition: 0,
				});
			}
			pausedAt = 0;
		};
		const ended = () => {
			completedPlayback = true;
			reportProgress(true, true);
			void pendingProgress.then(() => {
				if (!disposed) callbacks.current.onEnded?.();
			});
		};
		element.addEventListener("loadedmetadata", resume);
		element.addEventListener("durationchange", resume);
		element.addEventListener("pause", paused);
		element.addEventListener("play", resumed);
		element.addEventListener("seeked", resetCompleted);
		element.addEventListener("ended", ended);
		const timeupdate = () => {
			reportProgress();
			if (!live)
				setPosition((currentWorker.value?.offset ?? 0) + element.currentTime);
		};
		element.addEventListener("timeupdate", timeupdate);
		element.addEventListener("playing", playing);
		element.addEventListener("waiting", waiting);
		element.addEventListener("error", error);
		void (async () => {
			try {
				const data = await requestPlayback(itemId, options, () => disposed);
				if (!data || disposed) return;
				leaseId = data.id;
				live = data.live;
				liveRef.current = data.live;
				resumePosition = data.resumePosition ?? 0;
				currentWorker.value = data.worker;
				setWorker(data.worker);
				setSeek(null);
				setPosition(data.worker?.offset ?? data.resumePosition ?? 0);
				timer = setInterval(async () => {
					try {
						const heartbeat = await fetch(`/api/playback/${data.id}`, {
							method: "PATCH",
							headers: { "Content-Type": "application/json" },
						});
						if (!heartbeat.ok)
							fail("Pristup je istekao ili je lista promenjena.");
					} catch {
						fail("Veza sa serverom je prekinuta.");
					}
				}, 25000);
				if (data.format === "hls") {
					const { default: Hls } = await import("hls.js");
					if (disposed) return;
					if (!Hls.isSupported()) {
						if (element.canPlayType("application/vnd.apple.mpegurl")) {
							direct = true;
							element.src = data.url;
							play();
						} else fail("Ovaj pregledač ne podržava HLS reprodukciju.");
						return;
					}
					hls = new Hls({
						enableWorker: true,
						lowLatencyMode: false,
						maxBufferLength: 20,
						maxMaxBufferLength: 40,
						backBufferLength: 20,
						startPosition: data.live ? -1 : 0,
						liveSyncDurationCount: 3,
						liveMaxLatencyDurationCount: 6,
					});
					hlsRef.current = hls;
					const syncHlsTracks = () => {
						if (disposed || !hls) return;
						setAudioTracks(
							hls.audioTracks.map((track, index) => ({
								index,
								label: trackLabel(track.name, track.lang, index, "Audio"),
							})),
						);
						setSubtitleTracks(
							hls.subtitleTracks.map((track, index) => ({
								index,
								label: trackLabel(track.name, track.lang, index, "Titl"),
							})),
						);
						setAudioTrack(hls.audioTrack);
						setSubtitleTrack(hls.subtitleDisplay ? hls.subtitleTrack : -1);
					};
					hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, syncHlsTracks);
					hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, syncHlsTracks);
					hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, syncHlsTracks);
					hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, syncHlsTracks);
					hls.on(Hls.Events.MANIFEST_PARSED, () => {
						syncHlsTracks();
						play();
					});
					hls.on(Hls.Events.ERROR, (_event, data) => {
						if (!data.fatal || disposed) return;
						if (data.type === Hls.ErrorTypes.NETWORK_ERROR && retries < 3) {
							if (retryTimer) clearTimeout(retryTimer);
							const delay = 1000 * 2 ** retries++;
							setMessage("Ponovno povezivanje…");
							retryTimer = setTimeout(() => {
								if (!disposed) hls?.startLoad();
							}, delay);
						} else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
							recovered = true;
							hls?.recoverMediaError();
						} else
							fail("Reprodukcija je prekinuta. Zatvorite i pokušajte ponovo.");
					});
					hls.loadSource(data.url);
					hls.attachMedia(element);
				} else {
					direct = true;
					element.src = data.url;
					play();
				}
			} catch (error) {
				if (!disposed)
					fail(
						error instanceof Error
							? error.message
							: "Reprodukcija nije uspela.",
					);
			}
		})();
		const pagehide = () => {
			stop();
		};
		window.addEventListener("pagehide", pagehide);
		return () => {
			disposed = true;
			stop();
			window.removeEventListener("pagehide", pagehide);
			element.textTracks.removeEventListener("addtrack", syncNativeTracks);
			element.textTracks.removeEventListener("removetrack", syncNativeTracks);
			element.textTracks.removeEventListener("change", syncNativeTracks);
			element.removeEventListener("loadedmetadata", resume);
			element.removeEventListener("durationchange", resume);
			element.removeEventListener("pause", paused);
			element.removeEventListener("play", resumed);
			element.removeEventListener("seeked", resetCompleted);
			element.removeEventListener("ended", ended);
			element.removeEventListener("timeupdate", timeupdate);
			element.removeEventListener("playing", playing);
			element.removeEventListener("waiting", waiting);
			element.removeEventListener("error", error);
		};
	}, [itemId, options]);
	return (
		<section
			ref={panel}
			className={`player-panel cinema-player${controlsVisible || !isPlaying || settingsOpen ? " controls-visible" : ""}${fit ? " video-fill" : ""}${viewportFullscreen ? " viewport-fullscreen" : ""}${isFullscreen || viewportFullscreen || isVod ? " landscape-player" : ""}`}
			aria-label="Plejer"
			onPointerMove={wakeControls}
			onPointerDown={wakeControls}
			onFocus={wakeControls}
			onKeyDown={(event) => {
				wakeControls();
				if (
					event.target instanceof HTMLInputElement ||
					event.target instanceof HTMLSelectElement
				)
					return;
				if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
					event.preventDefault();
					seekTo(position + (event.key === "ArrowRight" ? 10 : -10));
				}
				if (event.key === " " && !(event.target instanceof HTMLButtonElement)) {
					event.preventDefault();
					void togglePlay();
				}
			}}
		>
			<div className="player-canvas">
				{/* biome-ignore lint/a11y/useMediaCaption: Provider tracks are attached dynamically. */}
				<video
					ref={video}
					playsInline
					preload="auto"
					aria-label="Video"
					tabIndex={0}
					onClick={(event) => {
						cancelVideoClick();
						if (liveRef.current || event.detail > 1) return;
						// Reserve the double-click window for fullscreen rather than toggling playback twice.
						videoClickTimer.current = setTimeout(() => {
							videoClickTimer.current = null;
							void togglePlay();
						}, 500);
					}}
					onDoubleClick={(event) => {
						event.preventDefault();
						cancelVideoClick();
						void toggleFullscreen();
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							cancelVideoClick();
							void togglePlay();
						}
					}}
				/>
				<div className="player-top player-overlay">
					<h2 className="player-title">{title}</h2>
					{(isFullscreen || viewportFullscreen) && !isVod && (
						<button
							className="player-icon player-exit-fullscreen"
							type="button"
							aria-label="Smanji plejer"
							title="Smanji plejer"
							onClick={() => void toggleFullscreen()}
						>
							<PlayerIcon name="exitFullscreen" />
						</button>
					)}
					<button
						className="player-icon"
						type="button"
						aria-label="Zatvori plejer"
						title="Zatvori plejer"
						onClick={onClose}
					>
						<PlayerIcon name="close" />
					</button>
				</div>
				{(message || controlError) && (
					<div
						className="player-message"
						role={controlError ? "alert" : "status"}
					>
						{controlError || message}
					</div>
				)}
				<div className="player-bottom player-overlay">
					{!liveRef.current && totalDuration > 0 && (
						<div className="player-timeline">
							<input
								aria-label="Pozicija filma"
								aria-valuetext={`${formatTime(seek ?? position)} od ${formatTime(totalDuration)}`}
								type="range"
								min="0"
								max={Math.max(0, Math.floor(totalDuration) - 1)}
								step="1"
								value={seek ?? Math.min(position, totalDuration - 1)}
								onPointerDown={(event) => {
									dragging.current = true;
									event.currentTarget.setPointerCapture(event.pointerId);
									setSeek(position);
								}}
								onChange={(event) => {
									const value = Number(event.target.value);
									if (dragging.current) setSeek(value);
									else seekTo(value);
								}}
								onPointerUp={(event) => {
									if (dragging.current) {
										dragging.current = false;
										seekTo(Number(event.currentTarget.value));
									}
								}}
								onPointerCancel={() => {
									dragging.current = false;
									setSeek(null);
									wakeControls();
								}}
							/>
							<span className="player-time">
								{formatTime(seek ?? position)} / {formatTime(totalDuration)}
							</span>
						</div>
					)}
					<div className="player-toolbar">
						<button
							type="button"
							className="player-icon player-play"
							aria-label={isPlaying ? "Pauziraj" : "Pusti"}
							title={isPlaying ? "Pauziraj" : "Pusti"}
							onClick={() => void togglePlay()}
						>
							<PlayerIcon name={isPlaying ? "pause" : "play"} />
						</button>
						<button
							type="button"
							className="player-icon"
							aria-label={isMuted ? "Uključi zvuk" : "Isključi zvuk"}
							title={isMuted ? "Uključi zvuk" : "Isključi zvuk"}
							onClick={() => {
								const element = video.current;
								if (!element) return;
								if (element.muted || !element.volume) {
									element.muted = false;
									if (!element.volume) element.volume = 0.5;
								} else element.muted = true;
							}}
						>
							<PlayerIcon name={isMuted ? "muted" : "volume"} />
						</button>
						<input
							className="player-volume"
							aria-label="Jačina zvuka"
							type="range"
							min="0"
							max="1"
							step="0.05"
							value={isMuted ? 0 : volume}
							onChange={(event) => {
								if (video.current) {
									video.current.volume = Number(event.target.value);
									video.current.muted = false;
								}
							}}
						/>
						{liveRef.current && <span className="player-live">UŽIVO</span>}
						<span className="player-toolbar-spacer" />
						<button
							type="button"
							className="player-icon"
							aria-label="Podešavanja plejera"
							title="Zvuk i titlovi"
							aria-expanded={settingsOpen}
							onClick={() => setSettingsOpen(!settingsOpen)}
						>
							<PlayerIcon name="settings" />
						</button>
						<button
							type="button"
							className="player-icon"
							aria-label={fit ? "Cela slika" : "Popuni ekran"}
							title={fit ? "Cela slika" : "Popuni ekran"}
							aria-pressed={fit}
							onClick={() => setFit(!fit)}
						>
							<PlayerIcon name="fit" />
						</button>
						<button
							type="button"
							className="player-icon"
							aria-label={
								isVod
									? "Vrati na izbor"
									: isFullscreen || viewportFullscreen
										? "Vrati prikaz"
										: "Ceo ekran"
							}
							title={
								isVod
									? "Vrati na izbor"
									: isFullscreen || viewportFullscreen
										? "Vrati prikaz"
										: "Ceo ekran"
							}
							onClick={() => void toggleFullscreen(true)}
						>
							<PlayerIcon
								name={
									isVod || isFullscreen || viewportFullscreen
										? "exitFullscreen"
										: "fullscreen"
								}
							/>
						</button>
					</div>
				</div>
				{settingsOpen && (
					<section
						className="player-settings"
						aria-label="Podešavanja reprodukcije"
					>
						{!worker && audioTracks.length > 1 && (
							<label>
								Zvuk
								<select
									aria-label="Zvuk"
									value={audioTrack}
									disabled={busy}
									onChange={(event) => {
										const index = Number(event.target.value);
										if (hlsRef.current) {
											hlsRef.current.audioTrack = index;
											setAudioTrack(index);
										}
									}}
								>
									{audioTracks.map((track) => (
										<option key={track.index} value={track.index}>
											{track.label}
										</option>
									))}
								</select>
							</label>
						)}
						{!worker && subtitleTracks.length > 0 && (
							<label>
								Titlovi
								<select
									aria-label="Titlovi"
									value={subtitleTrack}
									disabled={busy}
									onChange={(event) => {
										const index = Number(event.target.value);
										if (hlsRef.current) {
											hlsRef.current.subtitleDisplay = index !== -1;
											hlsRef.current.subtitleTrack = index;
										} else if (video.current)
											selectCaptionTrack(video.current.textTracks, index);
										setSubtitleTrack(index);
									}}
								>
									<option value={-1}>Isključeni</option>
									{subtitleTracks.map((track) => (
										<option key={track.index} value={track.index}>
											{track.label}
										</option>
									))}
								</select>
							</label>
						)}
						{worker && worker.subtitleTracks.length > 0 && (
							<label>
								Titlovi
								<select
									aria-label="Titlovi"
									value={worker.subtitleIndex ?? -1}
									disabled={busy}
									onChange={(event) => {
										const index = Number(event.target.value);
										setOptions({
											...options,
											subtitleIndex: index === -1 ? undefined : index,
											offset: worker.duration ? Math.max(0, position) : 0,
											resumePosition: 0,
										});
									}}
								>
									<option value={-1}>Isključeni</option>
									{worker.subtitleTracks.map((track, index) => (
										<option key={track.index} value={track.index}>
											{trackLabel(undefined, track.language, index, "Titl")}
										</option>
									))}
								</select>
							</label>
						)}
						{worker && worker.audioTracks.length > 1 && (
							<label>
								Zvuk
								<select
									aria-label="Zvuk"
									value={worker.audioIndex ?? ""}
									disabled={busy}
									onChange={(event) =>
										setOptions({
											...options,
											resumePosition: 0,
											audioIndex: Number(event.target.value),
											offset: worker.duration ? Math.max(0, position) : 0,
										})
									}
								>
									{worker.audioTracks.map((track, index) => (
										<option key={track.index} value={track.index}>
											{track.language === "und"
												? `Audio ${index + 1}`
												: track.language}
										</option>
									))}
								</select>
							</label>
						)}
					</section>
				)}
			</div>
		</section>
	);
}

function formatTime(value: number) {
	const seconds = Math.max(0, Math.floor(value));
	const hours = Math.floor(seconds / 3600);
	return `${hours ? `${hours}:` : ""}${String(Math.floor(seconds / 60) % 60).padStart(hours ? 2 : 1, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function PlayerIcon({
	name,
}: {
	name:
		| "close"
		| "play"
		| "pause"
		| "volume"
		| "muted"
		| "settings"
		| "fit"
		| "fullscreen"
		| "exitFullscreen";
}) {
	const paths = {
		close: "M6 6l12 12M6 18L18 6",
		play: "M8 5l11 7-11 7Z",
		pause: "M8 5v14M16 5v14",
		volume: "M11 4L6 8H3v8h3l5 4ZM15 8a6 6 0 010 8M18 5a10 10 0 010 14",
		muted: "M11 4L6 8H3v8h3l5 4ZM16 9l6 6M16 15l6-6",
		settings: "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6",
		fit: "M3 7V3h4M17 3h4v4M21 17v4h-4M7 21H3v-4M8 8h8v8H8Z",
		fullscreen: "M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5",
		exitFullscreen: "M3 8h5V3m8 0v5h5M3 16h5v5m8 0v-5h5",
	};
	return (
		<svg
			viewBox="0 0 24 24"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d={paths[name]} />
		</svg>
	);
}
