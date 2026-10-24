import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { verifyRelease } from "./verify-release.mjs";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "migecast-verifier-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const files = [];
	for (const path of [
		"app/server.js",
		"app/.next/BUILD_ID",
		"worker/dist/worker/main.js",
	]) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), "fixture");
		files.push({
			path,
			bytes: 7,
			sha256: createHash("sha256").update("fixture").digest("hex"),
		});
	}
	await symlink("server.js", join(root, "app/link.js"));
	files.push({ path: "app/link.js", symlink: "server.js" });
	const manifest = {
		schema: 1,
		id: "fixture",
		version: "1.0.0",
		revision: "a".repeat(40),
		dirty: false,
		localValidationOnly: false,
		platform: "linux",
		arch: "x64",
		glibc: "2.35",
		node: "v22.0.0",
		createdAt: new Date().toISOString(),
		dependencies: {},
		externalRuntimes: ["node", "ffmpeg", "ffprobe"],
		files,
	};
	const save = () =>
		writeFile(join(root, "release-manifest.json"), JSON.stringify(manifest));
	await save();
	return { root, manifest, save };
}

test("verifies complete production and labelled local bundle inventories", async (t) => {
	const { root, manifest, save } = await fixture(t);
	assert.equal((await verifyRelease(root)).files, 4);
	manifest.platform = "darwin";
	manifest.arch = "arm64";
	manifest.glibc = null;
	manifest.localValidationOnly = true;
	manifest.dirty = true;
	await save();
	assert.equal((await verifyRelease(root)).localValidationOnly, true);
});
for (const [name, mutate, pattern] of [
	[
		"same-size modification",
		(r) => writeFile(join(r, "app/server.js"), "changed"),
		/hash mismatch/,
	],
	[
		"size change",
		(r) => writeFile(join(r, "app/server.js"), "longer fixture"),
		/size or type/,
	],
	[
		"missing file",
		(r) => rm(join(r, "worker/dist/worker/main.js")),
		/Missing release entry/,
	],
	[
		"extra file",
		(r) => writeFile(join(r, "extra.js"), "extra"),
		/Unexpected release entry/,
	],
	[
		"escaping physical symlink",
		async (r) => {
			await rm(join(r, "app/link.js"));
			await symlink("../../outside", join(r, "app/link.js"));
		},
		/Invalid release symlink/,
	],
	[
		"file replaced with symlink",
		async (r) => {
			await rm(join(r, "worker/dist/worker/main.js"));
			await symlink(
				"../../../app/server.js",
				join(r, "worker/dist/worker/main.js"),
			);
		},
		/size or type/,
	],
])
	test(`rejects ${name}`, async (t) => {
		const { root } = await fixture(t);
		await mutate(root);
		await assert.rejects(verifyRelease(root), pattern);
	});
for (const path of [
	"../outside",
	"/absolute",
	"app/../outside",
	"app//double",
	"app\\outside",
	"C:/outside",
	"app/.env",
	"release-manifest.json",
])
	test(`rejects unsafe manifest path ${path}`, async (t) => {
		const { root, manifest, save } = await fixture(t);
		manifest.files[0].path = path;
		await save();
		await assert.rejects(verifyRelease(root), /Unsafe or duplicate/);
	});
test("rejects duplicate paths and invalid schema/platform metadata", async (t) => {
	const { root, manifest, save } = await fixture(t);
	const original = JSON.parse(
		await readFile(join(root, "release-manifest.json"), "utf8"),
	);
	for (const update of [
		{ schema: 2 },
		{ platform: "darwin" },
		{ dirty: true },
		{ arch: "arm64" },
		{ glibc: null },
		{ localValidationOnly: "false" },
		{ files: [...original.files, original.files[0]] },
	]) {
		Object.assign(manifest, original, update);
		await save();
		await assert.rejects(verifyRelease(root));
	}
});
test("rejects a manifest-approved escaping link, dangling link and symlinked manifest", async (t) => {
	const { root, manifest, save } = await fixture(t);
	manifest.files[3].symlink = "../../outside";
	await save();
	await assert.rejects(verifyRelease(root), /Unsafe manifest symlink/);
	manifest.files[3].symlink = "missing.js";
	await rm(join(root, "app/link.js"));
	await symlink("missing.js", join(root, "app/link.js"));
	await save();
	await assert.rejects(verifyRelease(root), /ENOENT/);
	await rm(join(root, "release-manifest.json"));
	await symlink("app/server.js", join(root, "release-manifest.json"));
	await assert.rejects(verifyRelease(root), /Invalid release manifest file/);
});

test("accepts empty directories excluded by inventory schema", async (t) => {
	const { root } = await fixture(t);
	await mkdir(join(root, "empty/nested"), { recursive: true });
	assert.equal((await verifyRelease(root)).files, 4);
});
