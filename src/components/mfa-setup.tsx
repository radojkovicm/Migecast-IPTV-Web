"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function MfaSetup() {
	const [secret, setSecret] = useState("");
	const [backupCodes, setBackupCodes] = useState<string[]>([]);
	const [saved, setSaved] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	return (
		<section className="panel">
			<h2>Zaštitite administratorski nalog</h2>
			<p>
				Pre upravljanja korisnicima uključite potvrdu prijave kroz aplikaciju za
				autentifikaciju.
			</p>
			<form
				className="form"
				onSubmit={async (event) => {
					event.preventDefault();
					setBusy(true);
					setError("");
					const form = new FormData(event.currentTarget);
					try {
						if (!secret) {
							const { data, error } = await authClient.twoFactor.enable({
								password: String(form.get("password")),
							});
							if (error || !data || data.method !== "totp") throw error;
							setSecret(new URL(data.totpURI).searchParams.get("secret") ?? "");
							setBackupCodes(data.backupCodes);
						} else {
							const { error } = await authClient.twoFactor.verifyTotp({
								code: String(form.get("code")).trim(),
							});
							if (error) throw error;
							setSecret("");
							setBackupCodes([]);
							window.location.reload();
						}
					} catch {
						setError(
							"Potvrda nije uspela. Proverite lozinku ili kod i pokušajte ponovo.",
						);
					} finally {
						setBusy(false);
					}
				}}
			>
				{!secret ? (
					<>
						<label htmlFor="password">Vaša lozinka</label>
						<input
							id="password"
							name="password"
							type="password"
							autoComplete="current-password"
							required
							maxLength={128}
						/>
					</>
				) : (
					<>
						<p>
							Dodajte vremenski kod (TOTP) u svojoj aplikaciji pod nazivom
							Migecast. Unesite ovaj ključ:
						</p>
						<code className="secret">{secret}</code>
						<p>
							Sačuvajte kodove za oporavak na sigurnom mestu. Svaki važi jednom:
						</p>
						<div className="secret">
							{backupCodes.map((code) => (
								<div key={code}>{code}</div>
							))}
						</div>
						<label>
							<input
								type="checkbox"
								checked={saved}
								onChange={(event) => setSaved(event.target.checked)}
								required
							/>{" "}
							Sačuvao sam kodove za oporavak
						</label>
						<label htmlFor="code">Šestocifreni kod iz aplikacije</label>
						<input
							id="code"
							name="code"
							inputMode="numeric"
							autoComplete="one-time-code"
							pattern="[0-9]{6}"
							maxLength={6}
							required
						/>
					</>
				)}
				{error && (
					<p role="alert" className="error">
						{error}
					</p>
				)}
				<button
					type="submit"
					className="primary"
					disabled={busy || (!!secret && !saved)}
				>
					{busy
						? "Provera…"
						: secret
							? "Potvrdi i nastavi"
							: "Podesi zaštitu naloga"}
				</button>
			</form>
		</section>
	);
}
