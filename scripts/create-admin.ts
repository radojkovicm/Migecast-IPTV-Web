import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "../src/generated/prisma/client";
import { hashPassword } from "../src/server/password";

if (existsSync(".env")) process.loadEnvFile(".env");

const input = z
	.object({
		DATABASE_URL: z.string().url(),
		ADMIN_USERNAME: z
			.string()
			.min(3)
			.max(30)
			.regex(/^[a-z0-9_.]+$/),
		ADMIN_EMAIL: z.string().email().max(254),
		ADMIN_PASSWORD: z.string().min(12).max(128),
	})
	.safeParse(process.env);

if (!input.success) {
	console.error(
		"Supply DATABASE_URL, ADMIN_USERNAME, ADMIN_EMAIL and a 12–128 character ADMIN_PASSWORD securely through the environment.",
	);
	process.exit(1);
}
const db = new PrismaClient({
	adapter: new PrismaPg({ connectionString: input.data.DATABASE_URL, max: 1 }),
});
try {
	const password = await hashPassword(input.data.ADMIN_PASSWORD);
	await db.$transaction(async (tx) => {
		// Serialize first-owner provisioning; no public bootstrap endpoint exists.
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(73642511)`;
		if (await tx.user.count()) throw new Error("Already initialized");
		const id = randomUUID();
		await tx.user.create({
			data: {
				id,
				name: input.data.ADMIN_USERNAME,
				username: input.data.ADMIN_USERNAME,
				displayUsername: input.data.ADMIN_USERNAME,
				email: input.data.ADMIN_EMAIL,
				emailVerified: true,
				role: "admin",
				accounts: {
					create: { accountId: id, providerId: "credential", password },
				},
			},
		});
	});
	console.info(
		"Administrator created. Sign in and enroll two-factor authentication before managing users.",
	);
} catch {
	console.error(
		"Administrator was not created. Check database connectivity and that the application has no existing users.",
	);
	process.exitCode = 1;
} finally {
	await db.$disconnect();
}
