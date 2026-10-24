import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	workers: 1,
	retries: 0,
	timeout: 60_000,
	use: {
		channel: "chromium",
		baseURL: process.env.TEST_BASE_URL,
		trace: "off",
		screenshot: "off",
	},
	reporter: "list",
});
