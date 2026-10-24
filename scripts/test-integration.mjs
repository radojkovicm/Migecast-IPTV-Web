import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

// Always create a fresh cluster; never consume DATABASE_URL from the caller.
const pgBin = process.env.TEST_PG_BIN || "/opt/homebrew/opt/postgresql@17/bin";
if (!existsSync(join(pgBin, "initdb")))
	throw new Error("Set TEST_PG_BIN to an installed PostgreSQL bin directory.");
const temp = mkdtempSync("/tmp/migecast-test-");
const data = join(temp, "data");
const output = openSync(join(temp, "output.log"), "a", 0o600);
let app;
let worker;
let databaseStarted = false;

async function port() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Port allocation failed");
	await new Promise((resolve) => server.close(resolve));
	return address.port;
}
function run(command, args, env) {
	const result = spawnSync(command, args, {
		env,
		stdio: ["ignore", output, output],
	});
	if (result.status !== 0)
		throw new Error(`${command} failed (${result.status})`);
}
try {
	const pgPort = await port();
	const appPort = await port();
	const mediaPort = await port();
	const workerPort = await port();
	const env = {
		...process.env,
		NODE_ENV: "development",
		MEDIA_TEST_ORIGIN: `http://127.0.0.1:${mediaPort}`,
		MEDIA_WORKER_URL: `http://127.0.0.1:${workerPort}`,
		MEDIA_WORKER_SECRET: randomBytes(32).toString("hex"),
		DATABASE_URL: `postgresql://migecast_test@127.0.0.1:${pgPort}/postgres`,
		BETTER_AUTH_URL: `http://127.0.0.1:${appPort}`,
		BETTER_AUTH_SECRET: randomBytes(48).toString("hex"),
		PLAYLIST_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
		ADMIN_USERNAME: "owner",
		ADMIN_EMAIL: "owner@example.invalid",
		ADMIN_PASSWORD: randomBytes(24).toString("hex"),
		NEXT_TELEMETRY_DISABLED: "1",
	};
	env.TEST_BASE_URL = env.BETTER_AUTH_URL;
	env.TEST_OWNER_PASSWORD = env.ADMIN_PASSWORD;
	env.TEST_VIEWER_PASSWORD = randomBytes(24).toString("hex");
	run(
		join(pgBin, "initdb"),
		[
			"-D",
			data,
			"--username=migecast_test",
			"--auth=trust",
			"--no-locale",
			"--encoding=UTF8",
		],
		env,
	);
	run(
		join(pgBin, "pg_ctl"),
		[
			"-D",
			data,
			"-l",
			join(temp, "postgres.log"),
			"-o",
			`-h 127.0.0.1 -p ${pgPort} -k ${temp}`,
			"-w",
			"start",
		],
		env,
	);
	databaseStarted = true;
	run("pnpm", ["worker:build"], env);
	worker = spawn(process.execPath, ["dist/worker/main.js"], {
		env: {
			PATH: process.env.PATH,
			NODE_ENV: "development",
			MEDIA_WORKER_PORT: String(workerPort),
			MEDIA_WORKER_SECRET: env.MEDIA_WORKER_SECRET,
			MEDIA_TEST_ORIGIN: env.MEDIA_TEST_ORIGIN,
			FFMPEG_PATH: process.env.FFMPEG_PATH,
			FFPROBE_PATH: process.env.FFPROBE_PATH,
		},
		stdio: ["ignore", output, output],
	});
	let workerReady = false;
	for (let i = 0; i < 50; i++) {
		try {
			if (
				(
					await fetch(`${env.MEDIA_WORKER_URL}/health`, {
						headers: { Authorization: `Bearer ${env.MEDIA_WORKER_SECRET}` },
					})
				).ok
			) {
				workerReady = true;
				break;
			}
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	if (!workerReady) throw new Error("Worker did not become ready");
	run("pnpm", ["db:deploy"], env);
	run("pnpm", ["admin:create"], env);
	app = spawn(
		process.execPath,
		[
			"node_modules/next/dist/bin/next",
			"dev",
			"--hostname",
			"127.0.0.1",
			"--port",
			String(appPort),
		],
		{ env, stdio: ["ignore", output, output] },
	);
	let ready = false;
	for (let i = 0; i < 60; i++) {
		try {
			const response = await fetch(`${env.TEST_BASE_URL}/login`);
			if (response.ok) {
				ready = true;
				break;
			}
		} catch {
			/* Wait for the isolated app. */
		}
		if (app.exitCode !== null) throw new Error("Test application exited");
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	if (!ready) throw new Error("Test application did not become ready");
	const tests = spawnSync("pnpm", ["exec", "playwright", "test"], {
		env,
		stdio: "inherit",
	});
	if (tests.status !== 0)
		throw new Error("Authentication integration tests failed");
	const connection = [
		"-h",
		"127.0.0.1",
		"-p",
		String(pgPort),
		"-U",
		"migecast_test",
	];
	const backup = join(temp, "scratch-backup.dump");
	run(
		join(pgBin, "pg_dump"),
		[...connection, "-Fc", "-f", backup, "postgres"],
		env,
	);
	run(join(pgBin, "createdb"), [...connection, "restore_check"], env);
	run(
		join(pgBin, "pg_restore"),
		[...connection, "--exit-on-error", "-d", "restore_check", backup],
		env,
	);
	run("pnpm", ["exec", "tsx", "scripts/verify-restore.ts"], {
		...env,
		TEST_RESTORE_DATABASE_URL: `postgresql://migecast_test@127.0.0.1:${pgPort}/restore_check`,
	});
	console.info(
		"Disposable PostgreSQL auth, browser playback, backup/restore and source decryption passed.",
	);
} catch (error) {
	console.error(error instanceof Error ? error.message : "Integration failure");
	// Tests use generated disposable credentials; do not print request bodies or env.
	const log = readFileSync(join(temp, "output.log"), "utf8");
	const errors = log
		.split("\n")
		.filter((line) => /^(Error|error|TypeError|Prisma|⨯|Invalid)/.test(line));
	console.error(
		errors
			.slice(-12)
			.map((line) => line.slice(0, 220))
			.join("\n"),
	);
	process.exitCode = 1;
} finally {
	if (worker && worker.exitCode === null) {
		worker.kill("SIGTERM");
		await Promise.race([
			new Promise((r) => worker.once("exit", r)),
			new Promise((r) => setTimeout(r, 5000)),
		]);
		if (worker.exitCode === null) worker.kill("SIGKILL");
	}
	if (app && app.exitCode === null) {
		app.kill("SIGTERM");
		await Promise.race([
			new Promise((resolve) => app.once("exit", resolve)),
			new Promise((resolve) => setTimeout(resolve, 5000)),
		]);
		if (app.exitCode === null) app.kill("SIGKILL");
	}
	if (databaseStarted)
		spawnSync(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], {
			stdio: "ignore",
		});
	closeSync(output);
	rmSync(temp, { recursive: true, force: true });
}
