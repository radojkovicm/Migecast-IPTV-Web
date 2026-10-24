import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin, twoFactor, username } from "better-auth/plugins";
import { createUserInput } from "./admin-input";
import { getDb } from "./db";
import { readEnvironment } from "./environment";
import { hashPassword, verifyPassword } from "./password";
import { allowUserCreation, canAdminister } from "./policy";

function createAuth() {
	const env = readEnvironment();
	const instance = betterAuth({
		appName: "Migecast",
		baseURL: env.BETTER_AUTH_URL,
		secret: env.BETTER_AUTH_SECRET,
		trustedOrigins: [env.BETTER_AUTH_URL],
		database: prismaAdapter(getDb(), { provider: "postgresql" }),
		emailAndPassword: {
			enabled: true,
			disableSignUp: true,
			minPasswordLength: 12,
			maxPasswordLength: 128,
			password: { hash: hashPassword, verify: verifyPassword },
		},
		session: {
			expiresIn: 60 * 60 * 24 * 30,
			updateAge: 60 * 60 * 24,
			cookieCache: { enabled: false },
		},
		rateLimit: {
			enabled: true,
			storage: "database",
			window: 60,
			max: 100,
			customRules: {
				"/sign-in/*": { window: 60, max: 10 },
				"/two-factor/*": { window: 60, max: 10 },
			},
		},
		databaseHooks: {
			user: {
				update: {
					after: async (user, ctx) => {
						// Enrollment rotates its current session in Better Auth. Revoke all
						// other pre-enrollment sessions before the plugin issues the new one.
						if (
							ctx?.path === "/two-factor/verify-totp" &&
							user.twoFactorEnabled
						) {
							await getDb().session.deleteMany({ where: { userId: user.id } });
						}
					},
				},
				create: {
					before: async (_user, ctx) => {
						if (!allowUserCreation(ctx?.path))
							throw new APIError("FORBIDDEN", {
								message: "Only the owner can create accounts.",
							});
					},
				},
			},
		},
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path.startsWith("/admin/")) {
					const session = ctx.headers
						? await instance.api.getSession({
								query: { disableRefresh: true },
								headers: ctx.headers,
							})
						: null;
					if (!canAdminister(session?.user))
						throw new APIError("FORBIDDEN", {
							message: "Owner access with two-factor authentication required.",
						});
					if (ctx.path === "/admin/create-user") {
						const input = createUserInput.safeParse(ctx.body);
						if (!input.success)
							throw new APIError("BAD_REQUEST", {
								message:
									"Provide a valid name, email, username and a 12–128 character password.",
							});
						return { context: { body: input.data } };
					}
				}
			}),
			after: createAuthMiddleware(async (ctx) => {
				if (ctx.path !== "/admin/set-user-password") return;
				const returned = ctx.context.returned;
				const result =
					returned instanceof Response
						? returned.status === 200
							? await returned.clone().json()
							: null
						: returned;
				if (
					result &&
					typeof result === "object" &&
					"status" in result &&
					result.status === true
				) {
					// Better Auth resets the credential but retains existing sessions.
					// Revoke server-side so callers cannot skip this step.
					await getDb().session.deleteMany({
						where: { userId: ctx.body.userId },
					});
				}
			}),
		},
		plugins: [username(), admin(), twoFactor({ issuer: "Migecast" })],
	});
	return instance;
}

let cached: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
	cached ??= createAuth();
	return cached;
}
