import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
	return (
		<main className="login">
			<div className="brand">
				<span className="brand-mark" aria-hidden="true">
					M
				</span>
				Migecast
			</div>
			<section className="login-card">
				<h1>Prijava</h1>
				<LoginForm />
				<p className="footnote">
					Za pristupne podatke obratite se administratoru.
				</p>
			</section>
		</main>
	);
}
