import { afterEach, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("pg", () => ({
	Pool: class {
		query = query;
		listenerCount() {
			return 1;
		}
	},
}));

import { readinessResponse } from "./readiness";

afterEach(() => {
	vi.unstubAllEnvs();
	query.mockReset();
});
it("reports database readiness without caching", async () => {
	vi.stubEnv("DATABASE_URL", "postgresql://fixture.invalid/test");
	query.mockResolvedValue({ rows: [{ value: 1 }] });
	const response = await readinessResponse();
	expect(response.status).toBe(200);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(await response.json()).toEqual({ status: "ready" });
	expect(query).toHaveBeenCalledWith("SELECT 1");
});
it("sanitizes database failures", async () => {
	vi.stubEnv("DATABASE_URL", "postgresql://fixture.invalid/test");
	query.mockRejectedValue(new Error("private connection details"));
	const response = await readinessResponse();
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ status: "unavailable" });
});
it("fails closed without database configuration", async () => {
	vi.stubEnv("DATABASE_URL", "");
	expect((await readinessResponse()).status).toBe(503);
	expect(query).not.toHaveBeenCalled();
});
