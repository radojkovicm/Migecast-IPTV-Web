import { z } from "zod";

const schema = z.object({
	DATABASE_URL: z
		.string()
		.url()
		.refine((url) => /^postgres(ql)?:/.test(url)),
	BETTER_AUTH_SECRET: z
		.string()
		.min(32)
		.refine((value) => !value.startsWith("replace-")),
	BETTER_AUTH_URL: z.string().url(),
});

export function readEnvironment(
	input: Record<string, string | undefined> = process.env,
) {
	const result = schema.safeParse(input);
	if (!result.success)
		throw new Error(
			"Configure DATABASE_URL, BETTER_AUTH_SECRET and BETTER_AUTH_URL before starting Migecast.",
		);
	const origin = new URL(result.data.BETTER_AUTH_URL);
	if (
		origin.origin !== result.data.BETTER_AUTH_URL ||
		origin.username ||
		origin.password
	) {
		throw new Error(
			"BETTER_AUTH_URL must be an exact origin without credentials or path.",
		);
	}
	if (input.NODE_ENV === "production" && origin.protocol !== "https:") {
		throw new Error("Production requires an HTTPS BETTER_AUTH_URL.");
	}
	return result.data;
}
