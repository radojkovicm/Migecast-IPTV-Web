"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { AccountControls } from "./account-controls";
import styles from "./admin-ui.module.css";

export function AdminPanel({
	users,
	ownerId,
}: {
	ownerId: string;
	users: {
		id: string;
		name: string;
		username: string | null;
		banned: boolean | null;
	}[];
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	return (
		<div className={styles.layout}>
			<section className={`panel ${styles.panel}`}>
				<h2>Korisnici</h2>
				<ul className="user-list">
					{users.map((user) => (
						<li key={user.id} className={styles.userRow}>
							<span className={styles.identity}>
								<strong>{user.name}</strong>
								<small className="muted">{user.username}</small>
							</span>
							<AccountControls user={user} owner={user.id === ownerId} />
						</li>
					))}
				</ul>
			</section>
			<section className={`panel ${styles.panel}`}>
				<h2>Dodaj korisnika</h2>
				<p className="muted">
					Korisnik može da gleda sadržaj. Liste i naloge uređujete samo vi.
				</p>
				<form
					className="form"
					onSubmit={async (event) => {
						event.preventDefault();
						setBusy(true);
						setError("");
						const form = new FormData(event.currentTarget);
						try {
							const { error } = await authClient.admin.createUser({
								name: String(form.get("name")),
								email: String(form.get("email")),
								password: String(form.get("password")),
								role: "user",
								data: {
									username: String(form.get("username")).trim().toLowerCase(),
								},
							});
							if (error) throw error;
							window.location.reload();
						} catch {
							setError(
								"Korisnik nije dodat. Proverite podatke i da li korisničko ime ili email već postoje.",
							);
							setBusy(false);
						}
					}}
				>
					<label htmlFor="name">Ime</label>
					<input id="name" name="name" required maxLength={80} />
					<label htmlFor="new-username">Korisničko ime</label>
					<input
						id="new-username"
						name="username"
						required
						minLength={3}
						maxLength={30}
						pattern="[a-zA-Z0-9_.]+"
						autoComplete="off"
					/>
					<label htmlFor="email">Email</label>
					<input
						id="email"
						name="email"
						type="email"
						required
						maxLength={254}
					/>
					<label htmlFor="new-password">
						Početna lozinka (najmanje 12 znakova)
					</label>
					<input
						id="new-password"
						name="password"
						type="password"
						required
						minLength={12}
						maxLength={128}
						autoComplete="new-password"
					/>
					{error && (
						<p role="alert" className="error">
							{error}
						</p>
					)}
					<button className="primary" type="submit" disabled={busy}>
						{busy ? "Dodavanje…" : "Dodaj korisnika"}
					</button>
				</form>
			</section>
		</div>
	);
}
