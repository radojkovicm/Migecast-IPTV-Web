import { z } from "zod";

export const createUserInput = z
	.object({
		name: z.string().trim().min(1).max(80),
		email: z.string().email().max(254),
		password: z.string().min(12).max(128),
		role: z.literal("user").default("user"),
		data: z
			.object({
				username: z
					.string()
					.trim()
					.toLowerCase()
					.min(3)
					.max(30)
					.regex(/^[a-z0-9_.]+$/),
			})
			.strict(),
	})
	.strict();
