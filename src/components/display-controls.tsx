"use client";

import { useEffect, useState } from "react";

/** Refresh through the HTTP endpoint so renewed cookies reach the browser. */
export function SessionKeepAlive() {
	useEffect(() => {
		let running = false;
		const controller = new AbortController();
		async function renew() {
			if (running) return;
			running = true;
			try {
				await fetch("/api/auth/get-session", {
					cache: "no-store",
					signal: controller.signal,
				});
			} catch {
				// A temporary connection loss must not interrupt playback or sign out.
			} finally {
				running = false;
			}
		}
		const visible = () => {
			if (document.visibilityState === "visible") void renew();
		};
		void renew();
		const timer = window.setInterval(() => void renew(), 60 * 60 * 1000);
		document.addEventListener("visibilitychange", visible);
		window.addEventListener("online", visible);
		return () => {
			controller.abort();
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", visible);
			window.removeEventListener("online", visible);
		};
	}, []);
	return null;
}

export function DisplayControls() {
	const [full, setFull] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		const sync = () => setFull(!!document.fullscreenElement);
		sync();
		document.addEventListener("fullscreenchange", sync);
		return () => document.removeEventListener("fullscreenchange", sync);
	}, []);
	return (
		<>
			<button
				type="button"
				className={`quiet${full ? " display-exit" : ""}`}
				aria-pressed={full}
				title={
					full
						? "Vrati manji prikaz (ili pritisni Esc)"
						: "Povećaj celu aplikaciju preko ekrana"
				}
				onClick={async () => {
					setError("");
					try {
						if (document.fullscreenElement) await document.exitFullscreen();
						else if (document.fullscreenEnabled)
							await document.documentElement.requestFullscreen();
						else throw new Error("unsupported");
					} catch {
						setError(
							"Browser ne dozvoljava ceo ekran. Koristite opciju za ceo ekran u meniju browsera.",
						);
					}
				}}
			>
				<svg
					width="24"
					height="24"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					aria-hidden="true"
				>
					<path
						d={
							full
								? "M3 8h5V3m8 0v5h5M3 16h5v5m8 0v-5h5"
								: "M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"
						}
					/>
				</svg>
				{full ? "Smanji ekran" : "Ceo ekran"}
			</button>
			{error && (
				<span role="status" className="display-help">
					{error}
				</span>
			)}
		</>
	);
}
