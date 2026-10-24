import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	selected: vi.fn(),
	item: vi.fn(),
	update: vi.fn(),
	load: vi.fn(),
	episodes: vi.fn(),
	findMany: vi.fn(),
	transaction: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/generated/prisma/client", () => ({ Prisma: {} }));
vi.mock(
	"@/lib/playlist-input",
	async () => await import("../lib/playlist-input"),
);
vi.mock("./db", () => ({
	getDb: () => ({
		playlistSelection: { findUnique: mocks.selected },
		catalogItem: {
			findFirst: mocks.item,
			updateMany: mocks.update,
			findMany: mocks.findMany,
		},
		$transaction: mocks.transaction,
	}),
}));
vi.mock("./playlist-crypto", () => ({
	decryptPlaylist: (_id: string, value: string) => JSON.parse(value),
	encryptPlaylist: (_id: string, value: unknown) => JSON.stringify(value),
}));
vi.mock("./http", () => ({
	HttpError: class extends Error {
		constructor(
			public status: number,
			message: string,
		) {
			super(message);
		}
	},
}));
vi.mock("./viewing", () => ({ withViewing: vi.fn() }));
vi.mock("./catalog-source", async (importOriginal) => ({
	...(await importOriginal<typeof import("./catalog-source")>()),
	loadMediaDetails: mocks.load,
	loadEpisodes: mocks.episodes,
}));

import { episodes, mediaDetails } from "./catalog";

const source = {
	id: "source",
	revision: 2,
	catalogRevision: 2,
	encryptedInput: JSON.stringify({
		kind: "xtream",
		server: "https://example.com",
		username: "fixture-user",
		password: "fixture-password",
	}),
};
const item = {
	id: "movie",
	kind: "movie",
	sourceKey: "movie:12",
	title: "Movie",
	encryptedLocator: "{}",
};
beforeEach(() => {
	vi.resetAllMocks();
	mocks.selected.mockResolvedValue({ assignment: { playlist: source } });
	mocks.item.mockResolvedValue(item);
	mocks.load.mockResolvedValue({ title: "Movie", description: "Story" });
	mocks.update.mockResolvedValue({ count: 1 });
	mocks.findMany.mockResolvedValue([]);
	mocks.transaction.mockResolvedValue(undefined);
});
describe("detail authorization and cache", () => {
	it("rejects unassigned or stale source before loading provider details", async () => {
		mocks.selected.mockResolvedValueOnce(null);
		await expect(mediaDetails("viewer", "movie")).rejects.toMatchObject({
			status: 404,
		});
		mocks.selected.mockResolvedValueOnce({
			assignment: { playlist: { ...source, revision: 3 } },
		});
		await expect(mediaDetails("viewer", "movie")).rejects.toMatchObject({
			status: 409,
		});
		expect(mocks.load).not.toHaveBeenCalled();
	});
	it("queries only the active playlist and denies a foreign item", async () => {
		mocks.item.mockResolvedValue(null);
		await expect(mediaDetails("viewer", "foreign")).rejects.toMatchObject({
			status: 404,
		});
		expect(mocks.item).toHaveBeenCalledWith({
			where: { id: "foreign", playlistId: "source" },
		});
		expect(mocks.load).not.toHaveBeenCalled();
	});
	it("guards cache writes against source edits and concurrent locator replacements", async () => {
		await expect(mediaDetails("viewer", "movie")).resolves.toMatchObject({
			description: "Story",
		});
		expect(mocks.update.mock.calls[0][0].where).toEqual({
			id: "movie",
			encryptedLocator: "{}",
			playlist: { revision: 2, catalogRevision: 2 },
		});
		const encryptedLocator =
			mocks.update.mock.calls[0][0].data.encryptedLocator;
		mocks.item.mockResolvedValue({ ...item, encryptedLocator });
		await mediaDetails("viewer", "movie");
		expect(mocks.load).toHaveBeenCalledTimes(1);
	});
});

function pendingDetails() {
	let resolve!: (value: { title: string; description: string }) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<{ title: string; description: string }>(
		(yes, no) => {
			resolve = yes;
			reject = no;
		},
	);
	return { promise, resolve, reject };
}

describe("bounded provider lookups", () => {
	it("joins an identical lookup only after each caller is authorized", async () => {
		const pending = pendingDetails();
		mocks.load.mockReturnValue(pending.promise);
		const first = mediaDetails("viewer", "movie");
		await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
		const second = mediaDetails("other-assigned-viewer", "movie");
		await vi.waitFor(() => expect(mocks.item).toHaveBeenCalledTimes(2));
		mocks.selected.mockResolvedValueOnce(null);
		await expect(mediaDetails("unassigned", "movie")).rejects.toMatchObject({
			status: 404,
		});
		pending.resolve({ title: "Movie", description: "Story" });
		expect(await first).toEqual(await second);
		expect(mocks.load).toHaveBeenCalledTimes(1);
		expect(mocks.update).toHaveBeenCalledTimes(1);
	});

	it("rejects a third distinct item immediately and releases capacity after errors", async () => {
		const pending = pendingDetails();
		mocks.item.mockImplementation(async ({ where }) => ({
			...item,
			id: where.id,
		}));
		mocks.load.mockReturnValue(pending.promise);
		const first = mediaDetails("viewer", "one");
		const second = mediaDetails("viewer", "two");
		const settled = Promise.allSettled([first, second]);
		await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
		await expect(mediaDetails("viewer", "three")).rejects.toMatchObject({
			status: 503,
		});
		expect(mocks.load).toHaveBeenCalledTimes(2);
		pending.reject(new Error("https://provider.invalid/private-secret"));
		for (const result of await settled) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected") {
				expect(result.reason.status).toBe(502);
				expect(result.reason.message).not.toContain("private-secret");
			}
		}
		mocks.load.mockResolvedValue({ title: "Recovered" });
		await expect(mediaDetails("viewer", "three")).resolves.toMatchObject({
			title: "Recovered",
		});
	});

	it("releases a completed lookup when persisting its cache fails", async () => {
		mocks.update.mockRejectedValueOnce(new Error("cache write failed"));
		await expect(mediaDetails("viewer", "movie")).rejects.toThrow(
			"cache write failed",
		);
		await expect(mediaDetails("viewer", "movie")).resolves.toMatchObject({
			description: "Story",
		});
		expect(mocks.load).toHaveBeenCalledTimes(2);
	});

	it.each(["revision", "locator"])(
		"does not join a replaced %s snapshot",
		async (change) => {
			const pending = pendingDetails();
			mocks.load.mockReturnValueOnce(pending.promise);
			const first = mediaDetails("viewer", "movie");
			await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
			if (change === "revision") {
				mocks.selected.mockResolvedValue({
					assignment: {
						playlist: { ...source, revision: 3, catalogRevision: 3 },
					},
				});
			} else {
				mocks.item.mockResolvedValue({
					...item,
					encryptedLocator: '{"artwork":"https://example.com/new.jpg"}',
				});
			}
			await expect(mediaDetails("viewer", "movie")).resolves.toMatchObject({
				description: "Story",
			});
			expect(mocks.load).toHaveBeenCalledTimes(2);
			pending.resolve({ title: "Old", description: "Old" });
			await first;
		},
	);

	it("shares the two-lookup budget with lazy episode loading", async () => {
		const pending = pendingDetails();
		mocks.load.mockReturnValue(pending.promise);
		mocks.item.mockImplementation(async ({ where }) => ({
			...item,
			id: where.id,
		}));
		const first = mediaDetails("viewer", "one");
		const second = mediaDetails("viewer", "two");
		await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
		mocks.item.mockResolvedValue({
			...item,
			id: "series",
			kind: "series",
			encryptedLocator: '{"seriesId":"1"}',
		});
		await expect(episodes("viewer", "series")).rejects.toMatchObject({
			status: 503,
		});
		expect(mocks.episodes).not.toHaveBeenCalled();
		pending.resolve({ title: "Movie", description: "Story" });
		await Promise.all([first, second]);
	});
});
