import { lookup } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import ipaddr from "ipaddr.js";

export class ProviderError extends Error {
	constructor(
		public code: "address" | "timeout" | "upstream" | "size" | "format",
	) {
		super(`Provider ${code}`);
	}
}
export function publicAddress(address: string) {
	try {
		return ipaddr.process(address).range() === "unicast";
	} catch {
		return false;
	}
}
function testOrigin(url: URL) {
	return (
		process.env.NODE_ENV === "development" &&
		process.env.MEDIA_TEST_ORIGIN === url.origin &&
		url.hostname === "127.0.0.1"
	);
}
export async function providerRequest(
	input: string,
	options: { signal?: AbortSignal; range?: string; timeoutMs?: number } = {},
	redirects = 0,
): Promise<{ response: IncomingMessage; url: string }> {
	const url = new URL(input);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		redirects > 4
	)
		throw new ProviderError("address");
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const addresses = await new Promise<{ address: string; family: number }[]>(
		(resolve, reject) => {
			const finish = () => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
			};
			const abort = () => {
				finish();
				reject(new ProviderError("timeout"));
			};
			const timer = setTimeout(abort, options.timeoutMs ?? 12000);
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) {
				abort();
				return;
			}
			void lookup(hostname, { all: true }).then(
				(value) => {
					finish();
					resolve(value);
				},
				() => {
					finish();
					reject(new ProviderError("address"));
				},
			);
		},
	);
	if (
		!addresses.length ||
		(!testOrigin(url) && addresses.some((a) => !publicAddress(a.address)))
	)
		throw new ProviderError("address");
	const address = addresses[0];
	const transport = url.protocol === "https:" ? https : http;
	const response = await new Promise<IncomingMessage>((resolve, reject) => {
		const req = transport.request(
			url,
			{
				method: "GET",
				signal: options.signal,
				headers: {
					"User-Agent": "Migecast/0.1",
					"Accept-Encoding": "identity",
					...(options.range ? { Range: options.range } : {}),
				},
				// Pin the validated address. Host and TLS SNI still use the original hostname.
				lookup: (_hostname, _options, callback) =>
					callback(null, address.address, address.family),
				agent: false,
				family: address.family,
			},
			resolve,
		);
		const timer = setTimeout(
			() => req.destroy(new ProviderError("timeout")),
			options.timeoutMs ?? 12000,
		);
		req.once("response", () => clearTimeout(timer));
		req.once("error", () => clearTimeout(timer));
		req.setTimeout(options.timeoutMs ?? 12000, () =>
			req.destroy(new ProviderError("timeout")),
		);
		req.on("error", () => reject(new ProviderError("upstream")));
		req.end();
	});
	if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
		response.destroy();
		if (!response.headers.location) throw new ProviderError("upstream");
		return providerRequest(
			new URL(response.headers.location, url).href,
			options,
			redirects + 1,
		);
	}
	if (![200, 206].includes(response.statusCode ?? 0)) {
		response.destroy();
		throw new ProviderError("upstream");
	}
	if (
		response.headers["content-encoding"] &&
		response.headers["content-encoding"] !== "identity"
	) {
		response.destroy();
		throw new ProviderError("format");
	}
	return { response, url: url.href };
}
export async function readProviderBody(
	response: IncomingMessage,
	maxBytes = 20 * 1024 * 1024,
) {
	let size = 0;
	const chunks: Buffer[] = [];
	try {
		for await (const chunk of response) {
			size += chunk.length;
			if (size > maxBytes) throw new ProviderError("size");
			chunks.push(Buffer.from(chunk));
		}
		return Buffer.concat(chunks);
	} finally {
		response.destroy();
	}
}
export async function providerText(url: string, maxBytes?: number) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 25000);
	try {
		const result = await providerRequest(url, { signal: controller.signal });
		return (await readProviderBody(result.response, maxBytes)).toString("utf8");
	} finally {
		clearTimeout(timer);
	}
}

type RecordLimits = {
	maxBytes?: number;
	maxRecordBytes?: number;
	maxRecords?: number;
};

/** Parse a JSON array without retaining the entire provider response. */
export async function* readProviderRecords(
	chunks: AsyncIterable<Uint8Array>,
	options: RecordLimits = {},
): AsyncGenerator<unknown> {
	const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
	const maxRecordBytes = options.maxRecordBytes ?? 2 * 1024 * 1024;
	const maxRecords = options.maxRecords ?? 500_000;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let bytes = 0;
	let count = 0;
	let state: "start" | "first" | "next" | "value" | "done" = "start";
	let depth = 0;
	let quoted = false;
	let escaped = false;
	let parts: string[] = [];
	let recordBytes = 0;
	const append = (part: string) => {
		if (!part) return;
		recordBytes += Buffer.byteLength(part);
		if (recordBytes > maxRecordBytes) throw new ProviderError("size");
		parts.push(part);
	};
	function parse() {
		if (++count > maxRecords) throw new ProviderError("size");
		try {
			return JSON.parse(parts.join("")) as unknown;
		} catch {
			throw new ProviderError("format");
		} finally {
			parts = [];
			recordBytes = 0;
		}
	}
	function* consume(text: string): Generator<unknown> {
		let start = state === "value" ? 0 : -1;
		for (let index = 0; index < text.length; index++) {
			const char = text[index];
			if (state !== "value") {
				if (char === " " || char === "\n" || char === "\r" || char === "\t")
					continue;
				if (state === "start") {
					if (char !== "[") throw new ProviderError("format");
					state = "first";
					continue;
				}
				if (state === "first" && char === "]") {
					state = "done";
					continue;
				}
				if (state === "done" || char === "," || char === "]")
					throw new ProviderError("format");
				state = "value";
				start = index;
			}
			if (quoted) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === '"') quoted = false;
				continue;
			}
			if (depth === 0 && (char === "," || char === "]")) {
				append(text.slice(start, index));
				const value = parse();
				state = char === "]" ? "done" : "next";
				start = -1;
				yield value;
			} else if (char === '"') quoted = true;
			else if (char === "{" || char === "[") depth++;
			else if (char === "}" || char === "]") {
				if (--depth < 0) throw new ProviderError("format");
			}
		}
		if (start >= 0) append(text.slice(start));
	}
	const isComplete = () => state === "done";
	try {
		for await (const chunk of chunks) {
			bytes += chunk.byteLength;
			if (bytes > maxBytes) throw new ProviderError("size");
			yield* consume(decoder.decode(chunk, { stream: true }));
		}
		yield* consume(decoder.decode());
		if (!isComplete()) throw new ProviderError("format");
	} catch (error) {
		if (error instanceof ProviderError) throw error;
		// Decoder and source errors must never expose provider URLs or credentials.
		throw new ProviderError(error instanceof TypeError ? "format" : "upstream");
	}
}

export async function* providerRecords(
	url: string,
	options: RecordLimits & { signal?: AbortSignal; timeoutMs?: number } = {},
): AsyncGenerator<unknown> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	const timer = setTimeout(abort, options.timeoutMs ?? 120_000);
	let response: IncomingMessage | undefined;
	try {
		({ response } = await providerRequest(url, { signal: controller.signal }));
		for await (const record of readProviderRecords(response, options)) {
			if (controller.signal.aborted) throw new ProviderError("timeout");
			yield record;
		}
	} catch (error) {
		if (controller.signal.aborted) throw new ProviderError("timeout");
		if (error instanceof ProviderError) throw error;
		throw new ProviderError("upstream");
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		response?.destroy();
		controller.abort();
	}
}

export async function inspectMedia(response: IncomingMessage) {
	const iterator = response[Symbol.asyncIterator]();
	const first = await iterator.next();
	if (first.done) throw new ProviderError("format");
	let chunk = Buffer.from(first.value);
	while (chunk.length < 1024) {
		const next = await iterator.next();
		if (next.done) break;
		chunk = Buffer.concat([chunk, Buffer.from(next.value)]);
	}
	const prefix = chunk
		.subarray(0, 32)
		.toString("utf8")
		.replace(/^\uFEFF/, "")
		.trimStart();
	const type = String(response.headers["content-type"] ?? "").toLowerCase();

	const ebml = chunk
		.subarray(0, 4)
		.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
	const isMov = chunk.subarray(4, 8).toString() === "ftyp";
	const isTs = [188, 192, 204].some((size) =>
		[0, 4].some(
			(start) =>
				chunk[start] === 0x47 &&
				chunk[start + size] === 0x47 &&
				chunk[start + 2 * size] === 0x47,
		),
	);
	const isWebm = ebml && chunk.subarray(0, 256).includes(Buffer.from("webm"));
	const container = isMov
		? "mov"
		: ebml
			? "matroska"
			: isTs
				? "mpegts"
				: undefined;
	const signatureMime = isMov ? "video/mp4" : isWebm ? "video/webm" : undefined;
	const mime =
		signatureMime ??
		(!ebml && /^video\/(mp4|webm)(?:;|$)/.test(type)
			? type.split(";")[0]
			: undefined);
	const kind =
		prefix.startsWith("#EXTM3U") || /mpegurl/.test(type)
			? "hls"
			: mime
				? "direct"
				: container
					? "worker"
					: "binary";
	return { iterator, chunk, kind, mime, container };
}
