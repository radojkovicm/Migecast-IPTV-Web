import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	selected: vi.fn(),
	favorites: vi.fn(),
	items: vi.fn(),
	count: vi.fn(),
	groups: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/generated/prisma/client", () => ({ Prisma: {} }));
vi.mock(
	"@/lib/playlist-input",
	async () => await import("../lib/playlist-input"),
);
vi.mock("./playlist-crypto", () => ({}));
vi.mock("./http", () => ({ HttpError: class extends Error {} }));
vi.mock("./viewing", () => ({
	withViewing: (
		_user: string,
		_source: string,
		_provider: string,
		items: unknown[],
	) => items,
}));
vi.mock("./db", () => ({
	getDb: () => ({
		playlistSelection: { findUnique: mocks.selected },
		viewingState: { findMany: mocks.favorites },
		catalogItem: {
			findMany: mocks.items,
			count: mocks.count,
			groupBy: mocks.groups,
		},
	}),
}));

import { catalog } from "./catalog";

beforeEach(() => {
	vi.resetAllMocks();
	mocks.selected.mockResolvedValue({
		assignment: {
			playlist: {
				id: "source",
				providerKey: "provider",
				revision: 1,
				catalogRevision: 1,
				categoryVisibility: null,
			},
		},
	});
	mocks.groups.mockResolvedValue([]);
	mocks.count.mockResolvedValue(61);
});
it("applies favorite order before pagination, preserving an unranked alphabetical tail", async () => {
	const channels = Array.from({ length: 61 }, (_, index) => ({
		id: String(index),
		title: String(index).padStart(2, "0"),
	}));
	mocks.items.mockImplementation(async () => [...channels]);
	mocks.favorites.mockResolvedValue(
		channels.map((item) => ({
			itemId: item.id,
			favoriteOrder: item.id === "60" ? 0 : null,
		})),
	);
	const first = await catalog("viewer", {
		kind: "tv",
		search: "",
		category: "",
		page: 0,
		favorites: true,
	});
	const second = await catalog("viewer", {
		kind: "tv",
		search: "",
		category: "",
		page: 1,
		favorites: true,
	});
	expect(first.items.map((item) => item.id)).toEqual([
		"60",
		...channels.slice(0, 59).map((item) => item.id),
	]);
	expect(second.items.map((item) => item.id)).toEqual(["59"]);
	expect(mocks.favorites.mock.calls[0][0].where).toEqual({
		userId: "viewer",
		playlistId: "source",
		providerKey: "provider",
		favorite: true,
	});
});
