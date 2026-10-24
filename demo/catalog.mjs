import { createHash } from "node:crypto";
import ipaddr from "ipaddr.js";

export function safePublicUrl(raw) {
	try {
		const url = new URL(raw);
		if (
			!["https:", "http:"].includes(url.protocol) ||
			url.username ||
			url.password
		)
			return null;
		const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
		if (
			!host.includes(".") ||
			/(^|\.)(localhost|local|internal|test|invalid)$/.test(host)
		)
			return null;
		if (ipaddr.isValid(host) && ipaddr.process(host).range() !== "unicast")
			return null;
		if (
			[...url.searchParams.keys()].some((key) =>
				/token|password|secret|auth|api.?key|signature/i.test(key),
			)
		)
			return null;
		return url.href;
	} catch {
		return null;
	}
}
export function parseCatalog(text) {
	if (!text.trimStart().startsWith("#EXTM3U"))
		throw new Error("Expected an M3U playlist");
	const channels = [],
		seen = new Set();
	let pending;
	for (const line of text.split(/\r?\n/).map((value) => value.trim())) {
		if (line.startsWith("#EXTINF:")) {
			const attributes = Object.fromEntries(
				[...line.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [
					match[1],
					match[2],
				]),
			);
			const title = line.match(/,(?![^"]*")(.*$)/)?.[1];
			pending = {
				name: (attributes["tvg-name"] || title || "Unnamed channel").slice(
					0,
					200,
				),
				country: (attributes["group-title"] || "Other").slice(0, 120),
				countryCode: /^[A-Z]{2}$/.test(attributes["tvg-country"])
					? attributes["tvg-country"]
					: "",
			};
		} else if (line && !line.startsWith("#") && pending) {
			const key = `${pending.country}\n${pending.name}\n${line}`;
			if (!seen.has(key)) {
				seen.add(key);
				const url = safePublicUrl(line);
				const kind =
					url?.startsWith("https:") && /\.m3u8(?:[?#]|$)/i.test(url)
						? "hls"
						: url?.startsWith("https:") && /\.(mp4|webm)(?:[?#]|$)/i.test(url)
							? "video"
							: url?.startsWith("https:")
								? "website"
								: "unsupported";
				channels.push({
					id: createHash("sha256").update(key).digest("hex").slice(0, 20),
					...pending,
					kind,
					url: url || "",
				});
			}
			pending = null;
		}
	}
	return channels;
}
