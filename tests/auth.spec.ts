import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { checkAccounts } from "./account-checks";
import { checkCategoryVisibility } from "./category-visibility-checks";
import { checkDisplay } from "./display-checks";
import { checkOwnerDiagnostics } from "./owner-diagnostics-checks";
import { checkPlayback } from "./playback-checks";
import { checkPlaylists } from "./playlist-checks";

function totp(secret: string) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	const bits = [...secret.toUpperCase().replace(/=+$/, "")]
		.map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0"))
		.join("");
	const key = Buffer.from(
		bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? [],
	);
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
	const hash = createHmac("sha1", key).update(counter).digest();
	const offset = hash[hash.length - 1] & 15;
	return ((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000)
		.toString()
		.padStart(6, "0");
}

test("closed signup, owner MFA, user creation, isolation, revocation and browser login", async ({
	playwright,
	page,
}) => {
	// The expanded login checks can legitimately exhaust the production rate window.
	// Includes media, category, fullscreen and owner-browser scenarios on shared CI runners.
	test.setTimeout(240_000);
	const baseURL = process.env.TEST_BASE_URL;
	const password = process.env.TEST_OWNER_PASSWORD;
	const viewerPassword = process.env.TEST_VIEWER_PASSWORD;
	if (!baseURL || !password || !viewerPassword)
		throw new Error(
			"Run pnpm test:integration with its disposable database harness.",
		);
	const anonymous = await playwright.request.newContext({
		baseURL,
		extraHTTPHeaders: { origin: baseURL },
	});
	const owner = await playwright.request.newContext({
		baseURL,
		extraHTTPHeaders: { origin: baseURL },
	});
	const olderOwnerSession = await playwright.request.newContext({
		baseURL,
		extraHTTPHeaders: { origin: baseURL },
	});
	const viewer = await playwright.request.newContext({
		baseURL,
		extraHTTPHeaders: { origin: baseURL },
	});
	try {
		await page.goto("/");
		await expect(page).toHaveURL(/\/login$/);
		await expect(
			page.getByRole("button", { name: "Prijavi se" }),
		).toBeVisible();
		const loginShot = process.env.TEST_SCREENSHOT_DIR;
		if (loginShot)
			await page.screenshot({ path: `${loginShot}/login.png`, fullPage: true });

		const signup = await anonymous.post("/api/auth/sign-up/email", {
			data: {
				name: "Intruder",
				email: "intruder@example.invalid",
				password: viewerPassword,
			},
		});
		expect(signup.ok()).toBe(false);
		const creation = {
			name: "Test Viewer",
			email: "viewer@example.invalid",
			password: viewerPassword,
			role: "user",
			data: { username: "viewer" },
		};
		expect(
			(
				await anonymous.post("/api/auth/admin/create-user", { data: creation })
			).status(),
		).toBe(403);
		expect(
			(
				await owner.post("/api/auth/sign-in/username", {
					data: { username: "owner", password: "wrong-test-password" },
				})
			).ok(),
		).toBe(false);
		expect(
			(
				await owner.post("/api/auth/sign-in/username", {
					data: { username: "owner", password },
				})
			).ok(),
		).toBe(true);
		expect(
			(
				await owner.post("/api/auth/admin/create-user", { data: creation })
			).status(),
		).toBe(403);

		expect(
			(
				await olderOwnerSession.post("/api/auth/sign-in/username", {
					data: { username: "owner", password },
				})
			).ok(),
		).toBe(true);
		const enrollment = await owner.post("/api/auth/two-factor/enable", {
			data: { password, method: "totp" },
		});
		expect(enrollment.ok()).toBe(true);
		const setup = await enrollment.json();
		const secret = new URL(setup.totpURI).searchParams.get("secret");
		if (!secret) throw new Error("TOTP secret missing");
		expect(
			(
				await owner.post("/api/auth/admin/create-user", { data: creation })
			).status(),
		).toBe(403);
		expect(
			(
				await owner.post("/api/auth/two-factor/verify-totp", {
					data: { code: totp(secret) },
				})
			).ok(),
		).toBe(true);
		expect(
			await (await olderOwnerSession.get("/api/auth/get-session")).json(),
		).toBeNull();
		for (const invalid of [
			{ ...creation, password: "short" },
			{ ...creation, password: undefined },
			{ ...creation, role: "admin" },
			{ ...creation, data: { username: "x" } },
		]) {
			expect(
				(
					await owner.post("/api/auth/admin/create-user", { data: invalid })
				).status(),
			).toBe(400);
		}
		const created = await owner.post("/api/auth/admin/create-user", {
			data: creation,
		});
		expect(created.ok()).toBe(true);
		const viewerId = (await created.json()).user.id;
		expect(
			(
				await viewer.post("/api/auth/sign-in/username", {
					data: { username: "viewer", password: viewerPassword },
				})
			).ok(),
		).toBe(true);
		expect(
			(
				await viewer.post("/api/auth/admin/create-user", {
					data: { ...creation, email: "other@example.invalid" },
				})
			).status(),
		).toBe(403);
		expect(
			(
				await viewer.post("/api/auth/admin/set-role", {
					data: { userId: viewerId, role: "admin" },
				})
			).status(),
		).toBe(403);
		expect((await viewer.get("/admin", { maxRedirects: 0 })).status()).toBe(
			307,
		);

		await page.getByLabel("Korisničko ime", { exact: true }).fill("viewer");
		await page.getByLabel("Lozinka", { exact: true }).fill(viewerPassword);
		await page.getByRole("button", { name: "Prijavi se" }).click();
		await expect(
			page.getByRole("link", { name: "TV", exact: true }),
		).toBeVisible();
		await expect(page.getByRole("link", { name: "Podešavanja" })).toHaveCount(
			0,
		);
		await checkDisplay(page, viewer, viewerId);
		if (loginShot)
			await page.screenshot({ path: `${loginShot}/home.png`, fullPage: true });
		await page.getByRole("link", { name: "Filmovi", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Filmovi", exact: true }),
		).toBeVisible();
		await page.goto("/admin");
		await expect(page).toHaveURL(`${baseURL}/`);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.reload();
		await expect(
			page.getByRole("link", { name: "Serije", exact: true }),
		).toBeVisible();
		await expect(page.locator("header")).toHaveCount(1);
		await page.evaluate(() => document.fonts.ready);
		if (loginShot)
			await page.screenshot({
				path: `${loginShot}/home-mobile.png`,
				fullPage: true,
			});
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);

		await checkPlaylists(owner, viewer, anonymous, viewerId, page);
		await checkPlayback(owner, viewer, anonymous, viewerId, page);
		await checkCategoryVisibility(owner, viewer, anonymous, viewerId, page);
		await checkOwnerDiagnostics(owner, viewer, anonymous, page, viewerId);
		await checkAccounts(
			owner,
			viewer,
			anonymous,
			viewerId,
			viewerPassword,
			page,
		);

		const crossOrigin = await owner.post("/api/auth/admin/create-user", {
			headers: { origin: "https://untrusted.example" },
			data: creation,
		});
		expect(crossOrigin.ok()).toBe(false);
		expect(
			(
				await owner.post("/api/auth/admin/revoke-user-sessions", {
					data: { userId: viewerId },
				})
			).ok(),
		).toBe(true);
		expect(await (await viewer.get("/api/auth/get-session")).json()).toBeNull();
		await page.goto("/");
		await expect(page).toHaveURL(/\/login$/);
		await owner.post("/api/auth/sign-out", { data: {} });
		let secondLogin = await owner.post("/api/auth/sign-in/username", {
			data: { username: "owner", password },
		});
		if (secondLogin.status() === 429) {
			const retryAfter = Number(secondLogin.headers()["x-retry-after"]);
			expect(Number.isFinite(retryAfter)).toBe(true);
			expect(retryAfter).toBeGreaterThanOrEqual(0);
			expect(retryAfter).toBeLessThanOrEqual(60);
			await new Promise((resolve) =>
				setTimeout(resolve, (retryAfter + 1) * 1000),
			);
			secondLogin = await owner.post("/api/auth/sign-in/username", {
				data: { username: "owner", password },
			});
		}
		expect((await secondLogin.json()).twoFactorRedirect).toBe(true);
		expect(await (await owner.get("/api/auth/get-session")).json()).toBeNull();
		expect(
			(
				await owner.post("/api/auth/admin/create-user", { data: creation })
			).status(),
		).toBe(403);
		expect(
			(
				await owner.post("/api/auth/two-factor/verify-backup-code", {
					data: { code: setup.backupCodes[0] },
				})
			).ok(),
		).toBe(true);
		expect(
			(
				await owner.post("/api/auth/admin/ban-user", {
					data: { userId: viewerId, banReason: "Integration test" },
				})
			).ok(),
		).toBe(true);
		expect(
			(
				await viewer.post("/api/auth/sign-in/username", {
					data: { username: "viewer", password: viewerPassword },
				})
			).ok(),
		).toBe(false);
		await owner.post("/api/auth/sign-out", { data: {} });
		await owner.post("/api/auth/sign-in/username", {
			data: { username: "owner", password },
		});
		expect(
			(
				await owner.post("/api/auth/two-factor/verify-backup-code", {
					data: { code: setup.backupCodes[0] },
				})
			).ok(),
		).toBe(false);
	} finally {
		await olderOwnerSession.dispose();
		await anonymous.dispose();
		await owner.dispose();
		await viewer.dispose();
	}
});
