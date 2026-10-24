import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { validateTemporaryStorage, workerConfig } from "./config";

const base = { MEDIA_WORKER_SECRET: "a".repeat(64) };
describe("worker resource configuration", () => {
	it("rejects invalid limits instead of silently widening capacity", () => {
		expect(workerConfig(base).maxJobs).toBe(1);
		for (const value of ["0", "3", "1.5", "Infinity", "garbage", ""])
			expect(() =>
				workerConfig({ ...base, MEDIA_WORKER_MAX_JOBS: value }),
			).toThrow();
		for (const value of ["yes", "true", "2"])
			expect(() =>
				workerConfig({ ...base, MEDIA_ALLOW_VIDEO_TRANSCODE: value }),
			).toThrow();
	});
	it("rejects production fixture overrides and relative binary paths", () => {
		expect(() =>
			workerConfig({
				...base,
				NODE_ENV: "production",
				MEDIA_TEST_ORIGIN: "http://127.0.0.1:1234",
			}),
		).toThrow();
		expect(() => workerConfig({ ...base, FFMPEG_PATH: "./ffmpeg" })).toThrow();
		expect(() =>
			workerConfig({ ...base, MEDIA_WORKER_PORT: "3101.5" }),
		).toThrow();
		expect(() =>
			workerConfig({ ...base, MEDIA_WORKER_SECRET: "invalid" }),
		).toThrow();
	});
	it("fails closed when Linux tmpfs isolation is required on another platform", async () => {
		if (process.platform !== "linux")
			await expect(validateTemporaryStorage(tmpdir(), true)).rejects.toThrow(
				"tmpfs",
			);
	});
});
