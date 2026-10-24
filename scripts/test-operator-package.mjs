import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import test from "node:test";
import {
	packageDependencyClosure,
	packageOperatorTools,
} from "./package-operator.mjs";

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "migecast-operator-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

async function file(path, content) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

async function pkg(path, metadata, code = "module.exports = 1;") {
	await file(
		join(path, "package.json"),
		JSON.stringify({ version: "1.0.0", main: "index.js", ...metadata }),
	);
	await file(join(path, "index.js"), code);
}

async function link(target, path) {
	await mkdir(dirname(path), { recursive: true });
	await symlink(relative(dirname(path), target), path);
}

test("operator graph preserves shared, cyclic, peer and optional dependencies after relocation", async (t) => {
	const temp = await fixture(t);
	const root = join(temp, "checkout");
	const a = join(root, "node_modules/.pnpm/a/node_modules/a");
	const b = join(root, "node_modules/.pnpm/b/node_modules/b");
	const shared = join(
		root,
		"node_modules/.pnpm/shared/node_modules/@scope/shared",
	);
	await pkg(
		a,
		{
			name: "a",
			dependencies: { b: "*", "@scope/shared": "*" },
			optionalDependencies: { "platform-absent": "*" },
			peerDependencies: { "optional-peer": "*" },
			peerDependenciesMeta: { "optional-peer": { optional: true } },
		},
		"exports.value = require('@scope/shared'); exports.b = require('b');",
	);
	await pkg(
		b,
		{
			name: "b",
			dependencies: { a: "*" },
			peerDependencies: { "@scope/shared": "*" },
		},
		"exports.value = require('@scope/shared'); exports.aPath = require.resolve('a');",
	);
	await pkg(shared, { name: "@scope/shared" }, "module.exports = 42;");
	await file(join(a, ".env"), "not-to-be-packaged");
	await file(join(a, "dynamic-engine.bin"), "runtime-asset");
	await link(a, join(root, "node_modules/a"));
	await link(b, join(dirname(a), "b"));
	await link(shared, join(dirname(a), "@scope/shared"));
	await link(a, join(dirname(b), "a"));
	await link(shared, join(dirname(b), "@scope/shared"));
	const output = join(temp, "bundle/node_modules");
	assert.equal(await packageDependencyClosure(root, output, ["a", "a"]), 3);
	assert.equal(isAbsolute(await readlink(join(output, "a"))), false);
	assert.equal(
		await readFile(join(output, "a/dynamic-engine.bin"), "utf8"),
		"runtime-asset",
	);
	await assert.rejects(readFile(join(output, "a/.env")), { code: "ENOENT" });
	await rename(join(temp, "bundle"), join(temp, "relocated"));
	await rename(root, join(temp, "hidden-checkout"));
	const result = execFileSync(
		process.execPath,
		[
			"-e",
			"const a=require('a'); if(a.value!==42 || a.b.value!==42) process.exit(1); console.log(a.b.aPath);",
		],
		{ cwd: join(temp, "relocated"), encoding: "utf8" },
	);
	assert.ok(result.startsWith(await realpath(join(temp, "relocated"))));
});

test("missing required dependency fails instead of creating an incomplete bundle", async (t) => {
	const temp = await fixture(t);
	await pkg(join(temp, "source/node_modules/a"), {
		name: "a",
		dependencies: { missing: "*" },
	});
	await assert.rejects(
		packageDependencyClosure(join(temp, "source"), join(temp, "output"), ["a"]),
		/Missing required operator dependency: missing/,
	);
});

test("operator bundle includes exact migration and provisioning sources", async (t) => {
	const temp = await fixture(t);
	const root = join(temp, "source");
	for (const name of [
		"prisma",
		"tsx",
		"@prisma/adapter-pg",
		"@prisma/client",
		"@node-rs/argon2",
		"zod",
	])
		await pkg(join(root, "node_modules", name), { name });
	for (const path of [
		"prisma.config.ts",
		"prisma/schema.prisma",
		"prisma/migrations/001/migration.sql",
		"scripts/create-admin.ts",
		"src/server/password.ts",
		"src/generated/prisma/client.ts",
	])
		await file(join(root, path), path);
	await file(join(root, "prisma/.env.secret"), "omit");
	await packageOperatorTools(root, join(temp, "bundle"));
	const operators = join(temp, "bundle/operators");
	assert.equal(
		JSON.parse(await readFile(join(operators, "package.json"), "utf8")).type,
		"module",
	);
	assert.equal(
		await readFile(
			join(operators, "prisma/migrations/001/migration.sql"),
			"utf8",
		),
		"prisma/migrations/001/migration.sql",
	);
	assert.ok(
		!(await readdir(join(operators, "prisma"))).includes(".env.secret"),
	);
});
