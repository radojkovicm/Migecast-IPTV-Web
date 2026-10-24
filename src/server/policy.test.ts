import { describe, expect, it } from "vitest";
import { readEnvironment } from "./environment";
import { hashPassword, verifyPassword } from "./password";
import { allowUserCreation, canAdminister } from "./policy";

describe("owner administration", () => {
	it("rejects anonymous, regular and unenrolled owner access", () => {
		for (const user of [
			undefined,
			null,
			{ role: "user", twoFactorEnabled: true },
			{ role: "admin", twoFactorEnabled: false },
			{ role: "admin" },
		])
			expect(canAdminister(user)).toBe(false);
		expect(canAdminister({ role: "admin", twoFactorEnabled: true })).toBe(true);
	});
	it("allows only the exact admin creation path", () => {
		for (const path of [
			undefined,
			"/sign-up/email",
			"/admin/create-user-extra",
			"/sign-in/social",
		])
			expect(allowUserCreation(path)).toBe(false);
		expect(allowUserCreation("/admin/create-user")).toBe(true);
	});
});
describe("password storage", () => {
	it("uses salted Argon2id hashes and rejects wrong passwords and malformed hashes", async () => {
		const value = "test-only-not-a-real-password";
		const first = await hashPassword(value);
		expect(first).toMatch(/^\$argon2id\$/);
		expect(first).not.toBe(await hashPassword(value));
		expect(await verifyPassword({ hash: first, password: value })).toBe(true);
		expect(await verifyPassword({ hash: first, password: "wrong" })).toBe(
			false,
		);
		expect(await verifyPassword({ hash: "invalid", password: value })).toBe(
			false,
		);
	});
});
describe("deployment configuration", () => {
	it("rejects placeholder secrets, non-origin URLs and production HTTP without leaking values", () => {
		const env = {
			DATABASE_URL: "postgresql://test@localhost/test",
			BETTER_AUTH_SECRET: "x".repeat(40),
			BETTER_AUTH_URL: "http://localhost:3100",
		};
		expect(readEnvironment(env)).toEqual(env);
		expect(() => readEnvironment({ ...env, NODE_ENV: "production" })).toThrow(
			"HTTPS",
		);
		expect(() =>
			readEnvironment({ ...env, BETTER_AUTH_URL: "https://example.com/path" }),
		).toThrow("exact origin");
		expect(() =>
			readEnvironment({
				...env,
				BETTER_AUTH_SECRET: "replace-with-at-least-32-random-characters",
			}),
		).toThrow("Configure");
	});
});
