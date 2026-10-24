"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function LoginForm() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [factor, setFactor] = useState(false);
	const [recovery, setRecovery] = useState(false);
	return (
		<form
			className="form"
			onSubmit={async (event) => {
				event.preventDefault();
				setBusy(true);
				setError("");
				const form = new FormData(event.currentTarget);
				try {
					if (factor) {
						const code = String(form.get("code") ?? "").trim();
						const result = recovery
							? await authClient.twoFactor.verifyBackupCode({ code })
							: await authClient.twoFactor.verifyTotp({ code });
						if (result.error) throw result.error;
					} else {
						const result = await authClient.signIn.username({
							username: String(form.get("username") ?? "").trim(),
							password: String(form.get("password") ?? ""),
						});
						if (result.error) throw result.error;
						if (
							result.data &&
							"twoFactorRedirect" in result.data &&
							result.data.twoFactorRedirect
						) {
							setFactor(true);
							setBusy(false);
							return;
						}
					}
					window.location.assign("/");
				} catch {
					setError(
						factor
							? "Kod nije ispravan ili je istekao. Pokušajte ponovo."
							: "Prijava nije uspela. Proverite podatke ili pokušajte malo kasnije.",
					);
					setBusy(false);
				}
			}}
		>
			{factor ? (
				<>
					<label htmlFor="code">
						{recovery
							? "Kod za oporavak"
							: "Kod iz aplikacije za autentifikaciju"}
					</label>
					<input
						id="code"
						name="code"
						autoComplete="one-time-code"
						inputMode={recovery ? "text" : "numeric"}
						required
						maxLength={64}
						aria-describedby={error ? "login-error" : undefined}
					/>
					<button
						type="button"
						className="quiet"
						onClick={() => {
							setRecovery(!recovery);
							setError("");
						}}
					>
						{recovery ? "Koristi aplikaciju" : "Koristi kod za oporavak"}
					</button>
				</>
			) : (
				<>
					<label htmlFor="username">Korisničko ime</label>
					<input
						id="username"
						name="username"
						autoComplete="username"
						required
						maxLength={30}
						aria-describedby={error ? "login-error" : undefined}
					/>
					<label htmlFor="password">Lozinka</label>
					<input
						id="password"
						name="password"
						type="password"
						autoComplete="current-password"
						required
						maxLength={128}
					/>
				</>
			)}
			{error && (
				<p className="error" id="login-error" role="alert">
					{error}
				</p>
			)}
			<button type="submit" className="primary" disabled={busy}>
				{busy ? "Provera…" : factor ? "Potvrdi" : "Prijavi se"}
			</button>
		</form>
	);
}
