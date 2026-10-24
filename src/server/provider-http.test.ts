import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { providerRecords, readProviderRecords } from "./provider-http";

async function* chunks(data: Uint8Array, size = data.length || 1) {
	for (let offset = 0; offset < data.length; offset += size) {
		yield data.subarray(offset, offset + size);
	}
}
async function collect(source: AsyncIterable<unknown>) {
	const result = [];
	for await (const value of source) result.push(value);
	return result;
}
const parse = (text: string, size = 1, options = {}) =>
	collect(readProviderRecords(chunks(Buffer.from(text), size), options));

describe("streaming provider catalog", () => {
	it("parses Unicode, escapes, nesting and primitives across every byte boundary", async () => {
		const values = [
			{
				name: 'Život 😀 [ , ] " \\',
				nested: [{ n: 12, values: [null, true] }],
			},
			false,
			-1.25e20,
			"escaped \n tab\t",
			null,
			[],
			{},
		];
		const text = ` \n${JSON.stringify(values)}\r\t`;
		for (let size = 1; size <= Buffer.byteLength(text); size++) {
			expect(await parse(text, size)).toEqual(values);
		}
		expect(await parse('["\\uD83D\\uDE00","\\u0061"]')).toEqual(["😀", "a"]);
		expect(await parse("[ \n ]")).toEqual([]);
	});
	it.each([
		"",
		"{}",
		"null",
		"[",
		"[1",
		"[1,]",
		"[,1]",
		"[1,,2]",
		"[1]x",
		"[1][2]",
		"[1 2]",
		'[{"a":1,}]',
		'[{"a":1]]',
		"[[1}]",
		'["unterminated]',
		'["bad\\x"]',
		'["line\nbreak"]',
		"[NaN]",
		"[01]",
		"[true false]",
		"[undefined]",
		"[\u00a01]",
	])("rejects malformed JSON %j without exposing the content", async (text) => {
		await expect(parse(text)).rejects.toThrow("Provider format");
	});
	it("rejects invalid and truncated UTF-8", async () => {
		for (const bytes of [
			[91, 34, 255, 34, 93],
			[91, 34, 0xe2, 0x82],
		]) {
			await expect(
				collect(readProviderRecords(chunks(Uint8Array.from(bytes), 1))),
			).rejects.toThrow("Provider format");
		}
	});
	it("enforces exact response, record byte and record count bounds", async () => {
		expect(
			await parse('["Ž"]', 1, {
				maxBytes: 6,
				maxRecordBytes: 4,
				maxRecords: 1,
			}),
		).toEqual(["Ž"]);
		await expect(parse('["Ž"]', 1, { maxBytes: 5 })).rejects.toThrow(
			"Provider size",
		);
		await expect(parse('["Ž"]', 1, { maxRecordBytes: 3 })).rejects.toThrow(
			"Provider size",
		);
		await expect(parse("[1,2]", 1, { maxRecords: 1 })).rejects.toThrow(
			"Provider size",
		);
	});
	it("yields before EOF and closes the source when its consumer stops", async () => {
		let requestedTail = false;
		let closed = false;
		async function* source() {
			try {
				yield Buffer.from('[{"id":1},');
				requestedTail = true;
				yield Buffer.from('{"id":2}]');
			} finally {
				closed = true;
			}
		}
		for await (const value of readProviderRecords(source())) {
			expect(value).toEqual({ id: 1 });
			break;
		}
		expect(requestedTail).toBe(false);
		expect(closed).toBe(true);
	});
	it("closes failed sources and sanitizes upstream errors", async () => {
		let closed = false;
		async function* source() {
			try {
				yield Buffer.from("[1,");
				throw new Error("private-provider-credentials");
			} finally {
				closed = true;
			}
		}
		await expect(collect(readProviderRecords(source()))).rejects.toThrow(
			"Provider upstream",
		);
		expect(closed).toBe(true);
	});
	it("streams a catalog larger than the former 20 MiB response cap", async () => {
		let count = 0;
		const record = JSON.stringify({ name: "x".repeat(400), stream_id: 123 });
		async function* source() {
			yield Buffer.from("[");
			for (let i = 0; i < 60_000; i++)
				yield Buffer.from(`${i ? "," : ""}${record}`);
			yield Buffer.from("]");
		}
		for await (const value of readProviderRecords(source())) {
			expect((value as { stream_id: number }).stream_id).toBe(123);
			count++;
		}
		expect(count).toBe(60_000);
	}, 15_000);
});

async function withProvider(
	handler: RequestListener,
	run: (url: string) => Promise<void>,
) {
	const server = createServer(handler);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Expected test port");
	const origin = `http://127.0.0.1:${address.port}`;
	vi.stubEnv("NODE_ENV", "development");
	vi.stubEnv("MEDIA_TEST_ORIGIN", origin);
	try {
		await run(`${origin}/catalog`);
	} finally {
		vi.unstubAllEnvs();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

describe("provider catalog HTTP lifecycle", () => {
	it("aborts a stalled body with the overall deadline", async () => {
		await withProvider(
			(_request, response) => {
				response.writeHead(200);
				response.write("[1,");
			},
			async (url) => {
				await expect(
					collect(providerRecords(url, { timeoutMs: 60 })),
				).rejects.toThrow("Provider timeout");
			},
		);
	});
	it("honors explicit cancellation", async () => {
		const controller = new AbortController();
		await withProvider(
			(_request, response) => {
				response.writeHead(200);
				response.write("[1,");
			},
			async (url) => {
				const records = providerRecords(url, { signal: controller.signal });
				expect(await records.next()).toEqual({ value: 1, done: false });
				controller.abort();
				await expect(records.next()).rejects.toThrow("Provider timeout");
			},
		);
	});
	it("destroys the response when the consumer breaks", async () => {
		let closed: Promise<unknown> | undefined;
		await withProvider(
			(_request, response) => {
				closed = once(response, "close");
				response.writeHead(200);
				response.write("[1,");
			},
			async (url) => {
				for await (const value of providerRecords(url)) {
					expect(value).toBe(1);
					break;
				}
				await closed;
			},
		);
	});
	it("rejects upstream status errors without returning response contents", async () => {
		await withProvider(
			(_request, response) => {
				response.writeHead(503);
				response.end("private-provider-credentials");
			},
			async (url) => {
				await expect(collect(providerRecords(url))).rejects.toThrow(
					"Provider upstream",
				);
			},
		);
	});
});
