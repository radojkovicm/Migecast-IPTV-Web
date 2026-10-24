import { hash, verify } from "@node-rs/argon2";

export function hashPassword(password: string) {
	return hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}
export async function verifyPassword({
	hash: encoded,
	password,
}: {
	hash: string;
	password: string;
}) {
	try {
		return await verify(encoded, password);
	} catch {
		return false;
	}
}
