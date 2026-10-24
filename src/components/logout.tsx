"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function Logout() {
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	return (
		<div>
			<button
				type="button"
				className="quiet"
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					setFailed(false);
					try {
						const { error } = await authClient.signOut();
						if (error) throw error;
						window.location.assign("/login");
					} catch {
						setFailed(true);
						setBusy(false);
					}
				}}
			>
				{busy ? "Odjavljivanje…" : "Odjavi se"}
			</button>
			{failed && <p role="alert">Odjava nije uspela. Pokušajte ponovo.</p>}
		</div>
	);
}
