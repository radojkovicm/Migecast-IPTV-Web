"use client";

import { useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";

import styles from "./admin-ui.module.css";

type Account = { id: string; name: string; banned: boolean | null };

export function AccountControls({
	user,
	owner,
}: {
	user: Account;
	owner: boolean;
}) {
	const passwordToggle = useRef<HTMLButtonElement>(null);
	const [banned, setBanned] = useState(Boolean(user.banned));
	const [busy, setBusy] = useState(false);
	const [passwordOpen, setPasswordOpen] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	async function perform(
		action: () => Promise<{ error: unknown }>,
		success: string,
	) {
		setBusy(true);
		setError("");
		setMessage("");
		try {
			const result = await action();
			if (result.error) throw result.error;
			setMessage(success);
			return true;
		} catch {
			setError(
				"Promena nije potvrđena. Pokušajte ponovo ili osvežite stranicu.",
			);
			return false;
		} finally {
			setBusy(false);
		}
	}
	if (owner)
		return <span className={`${styles.status} ${styles.owner}`}>Vlasnik</span>;
	return (
		<fieldset
			aria-label={`Nalog: ${user.name}`}
			className={styles.controls}
			aria-busy={busy}
		>
			<p className={`${styles.status} ${banned ? styles.blocked : ""}`}>
				{banned ? "Blokiran" : "Aktivan"}
			</p>
			<div className={`actions ${styles.actions}`}>
				<button
					type="button"
					className={`quiet ${!banned ? styles.danger : ""}`}
					disabled={busy}
					onClick={async () => {
						if (
							!banned &&
							!window.confirm(
								`Blokirati nalog ${user.name} i prekinuti sve njegove prijave?`,
							)
						)
							return;
						const next = !banned;
						if (
							await perform(
								() =>
									next
										? authClient.admin.banUser({ userId: user.id })
										: authClient.admin.unbanUser({ userId: user.id }),
								next
									? "Nalog je blokiran. Prijave su prekinute."
									: "Nalog je odblokiran.",
							)
						)
							setBanned(next);
					}}
				>
					{banned ? "Odblokiraj" : "Blokiraj"}
				</button>
				<button
					type="button"
					className="quiet"
					disabled={busy}
					onClick={async () => {
						if (
							!window.confirm(`Prekinuti sve prijave korisnika ${user.name}?`)
						)
							return;
						await perform(
							() => authClient.admin.revokeUserSessions({ userId: user.id }),
							"Sve prijave su prekinute.",
						);
					}}
				>
					Prekini prijave
				</button>
				<button
					type="button"
					className="quiet"
					disabled={busy}
					ref={passwordToggle}
					aria-expanded={passwordOpen}
					aria-controls={`password-form-${user.id}`}
					onClick={() => {
						setPasswordOpen(!passwordOpen);
						setError("");
						setMessage("");
					}}
				>
					Promeni lozinku
				</button>
			</div>
			{passwordOpen && (
				<form
					id={`password-form-${user.id}`}
					className={`form ${styles.passwordForm}`}
					onSubmit={async (event) => {
						event.preventDefault();
						const form = event.currentTarget;
						const data = new FormData(form);
						if (data.get("password") !== data.get("confirmation")) {
							setError("Lozinke se ne podudaraju.");
							return;
						}
						if (
							!window.confirm(
								`Promeniti lozinku korisnika ${user.name} i prekinuti sve njegove prijave?`,
							)
						)
							return;
						if (
							await perform(
								() =>
									authClient.admin.setUserPassword({
										userId: user.id,
										newPassword: String(data.get("password")),
									}),
								"Lozinka je promenjena. Sve prijave su prekinute.",
							)
						) {
							form.reset();
							setPasswordOpen(false);
							requestAnimationFrame(() => passwordToggle.current?.focus());
						}
					}}
				>
					<label htmlFor={`password-${user.id}`}>
						Nova lozinka (najmanje 12 znakova)
					</label>
					<input
						id={`password-${user.id}`}
						name="password"
						type="password"
						required
						minLength={12}
						maxLength={128}
						autoComplete="new-password"
						aria-describedby={error ? `account-error-${user.id}` : undefined}
						disabled={busy}
					/>
					<label htmlFor={`confirmation-${user.id}`}>
						Potvrdi novu lozinku
					</label>
					<input
						id={`confirmation-${user.id}`}
						name="confirmation"
						type="password"
						required
						minLength={12}
						maxLength={128}
						autoComplete="new-password"
						aria-describedby={error ? `account-error-${user.id}` : undefined}
						disabled={busy}
					/>
					<div className={`actions ${styles.actions}`}>
						<button className="primary" type="submit" disabled={busy}>
							Sačuvaj lozinku
						</button>
						<button
							className="quiet"
							type="button"
							disabled={busy}
							onClick={() => {
								setPasswordOpen(false);
								setError("");
								passwordToggle.current?.focus();
							}}
						>
							Otkaži
						</button>
					</div>
				</form>
			)}
			{message && <p role="status">{message}</p>}
			{error && (
				<p id={`account-error-${user.id}`} role="alert" className="error">
					{error}
				</p>
			)}
		</fieldset>
	);
}
