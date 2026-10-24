import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "Migecast",
	description: "Vaša televizija, filmovi i serije.",
	robots: { index: false, follow: false },
};
export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html lang="sr-Latn">
			<body>{children}</body>
		</html>
	);
}
