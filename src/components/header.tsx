import Link from "next/link";
import styles from "./admin-ui.module.css";
import { DisplayControls, SessionKeepAlive } from "./display-controls";
import { Logout } from "./logout";

export function Header({
	name,
	owner,
	section,
}: {
	name: string;
	owner: boolean;
	section?: string;
}) {
	return (
		<header className={`header ${styles.compactHeader}`}>
			<Link href="/" className="brand" aria-label="Migecast početna">
				<svg
					width="34"
					height="34"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.7"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<rect x="3" y="5" width="18" height="13" rx="3" />
					<path d="M8 22h8 M12 18v4 M9 9l6 3-6 3z" />
				</svg>{" "}
				MigeCast IPTV
			</Link>
			<span className="breadcrumb">
				Početna{section ? ` › ${section}` : ""}
			</span>
			<nav className={styles.headerActions} aria-label="Glavna navigacija">
				<span className="sr-only">Prijavljen: {name}</span>
				{section && (
					<Link className="button quiet" href="/">
						← Nazad
					</Link>
				)}
				{owner && (
					<Link className="button quiet" href="/admin">
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.8"
							strokeLinecap="round"
							aria-hidden="true"
						>
							<path d="M4 7h16M4 17h16" />
							<circle cx="9" cy="7" r="3" fill="currentColor" />
							<circle cx="15" cy="17" r="3" fill="currentColor" />
						</svg>
						Podešavanja
					</Link>
				)}
				<DisplayControls />
				<SessionKeepAlive />
				{owner && <Logout />}
			</nav>
		</header>
	);
}
