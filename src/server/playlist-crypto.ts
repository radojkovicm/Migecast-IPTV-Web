import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	randomBytes,
} from "node:crypto";

export function playlistKey(
	value = process.env.PLAYLIST_ENCRYPTION_KEY,
): Buffer {
	if (!value || !/^[0-9a-fA-F]{64}$/.test(value))
		throw new Error("Configure a separate 32-byte PLAYLIST_ENCRYPTION_KEY.");
	return Buffer.from(value, "hex");
}
export function encryptPlaylist(
	sourceId: string,
	input: unknown,
	key = playlistKey(),
) {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(`migecast:playlist:v1:${sourceId}`));
	const encrypted = Buffer.concat([
		cipher.update(JSON.stringify(input), "utf8"),
		cipher.final(),
	]);
	return [
		"v1",
		iv.toString("base64url"),
		cipher.getAuthTag().toString("base64url"),
		encrypted.toString("base64url"),
	].join(".");
}
export function decryptPlaylist(
	sourceId: string,
	envelope: string,
	key = playlistKey(),
): unknown {
	try {
		const [version, iv, tag, value, extra] = envelope.split(".");
		if (version !== "v1" || !iv || !tag || !value || extra !== undefined)
			throw new Error();
		const decipher = createDecipheriv(
			"aes-256-gcm",
			key,
			Buffer.from(iv, "base64url"),
		);
		decipher.setAAD(Buffer.from(`migecast:playlist:v1:${sourceId}`));
		decipher.setAuthTag(Buffer.from(tag, "base64url"));
		return JSON.parse(
			Buffer.concat([
				decipher.update(Buffer.from(value, "base64url")),
				decipher.final(),
			]).toString("utf8"),
		);
	} catch {
		throw new Error("Playlist could not be decrypted.");
	}
}
export function playlistIdentity(identity: string, key = playlistKey()) {
	return createHmac("sha256", key).update(identity).digest("hex");
}
