import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	users: vi.fn(),
	lists: vi.fn(),
	leases: vi.fn(),
	counts: vi.fn(),
	sessions: vi.fn(),
	worker: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("./db", () => ({
	getDb: () => ({
		user: { findMany: mocks.users },
		playlist: { findMany: mocks.lists },
		playbackLease: { findMany: mocks.leases },
		catalogItem: { groupBy: mocks.counts },
		session: { groupBy: mocks.sessions },
	}),
}));
vi.mock("./worker-client", () => ({ workerRequest: mocks.worker }));

import { ownerDiagnostics } from "./owner-diagnostics";

beforeEach(() => {
	vi.resetAllMocks();
	mocks.users.mockResolvedValue([
		{
			id: "viewer",
			name: "Viewer",
			username: "viewer",
			banned: true,
			banExpires: new Date(0),
			playlistSelection: { playlistId: "list" },
			_count: { playlistAssignments: 1 },
		},
		{
			id: "other",
			name: "Other",
			username: "other",
			banned: true,
			banExpires: null,
			playlistSelection: null,
			_count: { playlistAssignments: 0 },
		},
	]);
	mocks.lists.mockResolvedValue([
		{
			id: "list",
			name: "List",
			providerKey: "never-expose",
			revision: 2,
			catalogRevision: 1,
			catalogUpdatedAt: new Date(0),
			categoryVisibility: { tv: [], movie: ["Drama"], series: null },
		},
	]);
	mocks.leases.mockResolvedValue([
		{ userId: "other", playlistId: "alias", providerKey: "never-expose" },
	]);
	mocks.counts.mockResolvedValue([
		{ playlistId: "list", kind: "tv", _count: { _all: 3 } },
	]);
	mocks.sessions.mockResolvedValue([
		{ userId: "viewer", _count: { _all: 1 }, _max: { updatedAt: new Date(0) } },
	]);
	mocks.worker.mockResolvedValue(
		Response.json({ ready: true, jobs: 1, maxJobs: 1, secret: "never-expose" }),
	);
});

describe("owner diagnostics", () => {
	it("identifies expired bans, hidden categories, stale catalogs and alias contention without leaking provider identity", async () => {
		const data = await ownerDiagnostics();
		expect(data.users[0]).toMatchObject({
			blocked: false,
			blockedBy: "other",
			activeSessions: 1,
			playing: false,
		});
		expect(data.users[1]).toMatchObject({
			blocked: true,
			playing: true,
			assignedLists: 0,
		});
		expect(data.playlists[0]).toMatchObject({
			catalogReady: false,
			occupiedBy: "other",
			occupiedPlaylistId: "alias",
		});
		expect(data.playlists[0].sections).toEqual([
			{ kind: "tv", items: 3, allowedCategories: 0 },
			{ kind: "movie", items: 0, allowedCategories: 1 },
			{ kind: "series", items: 0, allowedCategories: null },
		]);
		expect(JSON.stringify(data)).not.toContain("never-expose");
		expect(mocks.worker).toHaveBeenCalledExactlyOnceWith("/health");
		expect(mocks.users.mock.calls[0][0].take).toBe(101);
		expect(mocks.leases.mock.calls[0][0].where.expiresAt.gt).toBeInstanceOf(
			Date,
		);
	});
	it("reports worker failure without serializing network errors", async () => {
		mocks.worker.mockRejectedValue(new Error("secret upstream locator"));
		const data = await ownerDiagnostics();
		expect(data.worker).toEqual({ ready: false, jobs: null, maxJobs: null });
		expect(JSON.stringify(data)).not.toContain("secret upstream locator");
	});
});
