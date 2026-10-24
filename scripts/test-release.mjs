import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allowedPath, inventory, packageRelease } from "./package-release.mjs";

test("release paths exclude environment, key and development output", () => {
	for (const path of [
		".env",
		"app/.env.production",
		"app/key.pem",
		"worker/private.key",
		"app/.npmrc",
		"app/.next/cache/image",
	])
		assert.equal(allowedPath(path), false);
	for (const path of [
		"app/server.js",
		"app/.next/static/chunk.js",
		"worker/node_modules/zod/index.js",
	])
		assert.equal(allowedPath(path), true);
});
test("inventory hashes files and rejects escaping symlinks", async () => {
	const root = await mkdtemp(join(tmpdir(), "migecast-release-test-"));
	try {
		await mkdir(join(root, "package"));
		await writeFile(join(root, "package/main.js"), "fixture");
		await symlink("package/main.js", join(root, "entry.js"));
		const files = await inventory(root);
		assert.equal(files.find((file) => file.sha256)?.sha256.length, 64);
		await symlink(tmpdir(), join(root, "outside"));
		await assert.rejects(inventory(root), /Non-relocatable/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("production bundle rejects a non-Linux x64 host", async () => {
	if (process.platform !== "linux" || process.arch !== "x64")
		await assert.rejects(packageRelease(), /Linux x64/);
});
