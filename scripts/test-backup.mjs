import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve("deploy/backup-postgres.sh");
const linux = {
	skip:
		process.platform !== "linux"
			? "Requires real Linux stat and flock; only Docker is stubbed"
			: false,
};
async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "migecast-backup-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const backup = join(root, "backups");
	const bin = join(root, "bin");
	await mkdir(backup, { mode: 0o700 });
	await mkdir(bin);
	await writeFile(
		join(bin, "docker"),
		`#!/usr/bin/env bash
set -eu
case " $* " in
 *" sh -c "*) printf '%s' "\${TEST_IDENTITY:-migecast:migecast}" ;;
 *" pg_dump "*) printf 'PGDMPfixture'; if [[ "\${TEST_FAILURE:-}" == dump ]]; then exit 1; fi ;;
 *" pg_restore "*) content=$(cat); [[ "$content" == PGDMP* && "\${TEST_FAILURE:-}" != restore ]] ;;
 *) exit 9 ;;
esac
`,
	);
	await chmod(join(bin, "docker"), 0o755);
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		APP_DIR: join(root, "app"),
		BACKUP_DIR: backup,
		KEEP: "2",
	};
	const run = (extra = {}, command = "bash", args = [script]) =>
		spawnSync(command, args, {
			env: { ...env, ...extra },
			encoding: "utf8",
			timeout: 10000,
		});
	return { root, backup, run };
}

test(
	"backup publishes a private dump and rotates only validated exact-name dumps",
	linux,
	async (t) => {
		const { backup, run } = await fixture(t);
		for (const name of [
			"migecast-20000101T000000Z.dump",
			"migecast-20000102T000000Z.dump",
			"migecast-unrelated.dump",
		])
			await writeFile(join(backup, name), "PGDMPold");
		await writeFile(
			join(backup, "migecast-19990101T000000Z.dump"),
			"invalid archive",
		);
		await symlink(
			"migecast-20000102T000000Z.dump",
			join(backup, "migecast-19990102T000000Z.dump"),
		);
		const result = run();
		assert.equal(result.status, 0, result.stderr);
		const files = await readdir(backup);
		assert(!files.includes("migecast-20000101T000000Z.dump"));
		for (const preserved of [
			"migecast-20000102T000000Z.dump",
			"migecast-unrelated.dump",
			"migecast-19990101T000000Z.dump",
			"migecast-19990102T000000Z.dump",
		])
			assert(files.includes(preserved));
		const created = files.filter(
			(name) =>
				/^migecast-\d{8}T\d{6}Z.dump$/.test(name) &&
				!name.startsWith("migecast-1999") &&
				!name.startsWith("migecast-2000"),
		);
		assert.equal(created.length, 1);
		assert.equal((await stat(join(backup, created[0]))).mode & 0o777, 0o600);
		assert(!files.some((name) => name.startsWith(".migecast-partial.")));
	},
);
for (const mode of ["dump", "restore"])
	test(
		`backup ${mode} failure removes partial file and preserves existing backup`,
		linux,
		async (t) => {
			const { backup, run } = await fixture(t);
			await writeFile(
				join(backup, "migecast-20000101T000000Z.dump"),
				"PGDMPexisting",
			);
			assert.notEqual(run({ TEST_FAILURE: mode }).status, 0);
			assert.deepEqual((await readdir(backup)).sort(), [
				".backup.lock",
				"migecast-20000101T000000Z.dump",
			]);
		},
	);
test("backup refuses unexpected database identity", linux, async (t) => {
	const { backup, run } = await fixture(t);
	assert.notEqual(run({ TEST_IDENTITY: "other:other" }).status, 0);
	assert.deepEqual(await readdir(backup), [".backup.lock"]);
});
test(
	"backup refuses insecure directory, symlinked lock and invalid retention",
	linux,
	async (t) => {
		const { root, backup, run } = await fixture(t);
		await chmod(backup, 0o755);
		assert.notEqual(run().status, 0);
		await chmod(backup, 0o700);
		for (const KEEP of ["0", "100", "-1", "a"])
			assert.notEqual(run({ KEEP }).status, 0);
		const target = join(root, "untouched");
		await writeFile(target, "preserved");
		await symlink(target, join(backup, ".backup.lock"));
		assert.notEqual(run().status, 0);
		assert.equal(await readFile(target, "utf8"), "preserved");
	},
);
test(
	"backup refuses a concurrent lock without publishing",
	linux,
	async (t) => {
		const { backup, run } = await fixture(t);
		const result = run({}, "flock", [
			"-n",
			join(backup, ".backup.lock"),
			"bash",
			script,
		]);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Another Migecast backup/);
		assert.deepEqual(await readdir(backup), [".backup.lock"]);
	},
);
