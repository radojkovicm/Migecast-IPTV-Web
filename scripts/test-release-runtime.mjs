import assert from "node:assert/strict";
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
import { join, resolve } from "node:path";
import { verifyRelease } from "./verify-release.mjs";

// Only generated credentials and a newly initialized cluster are used.
const bundle = resolve(process.argv[2] || "");
if (!process.argv[2])
	throw new Error("Usage: test-release-runtime.mjs BUNDLE_DIRECTORY");
const manifest = await verifyRelease(bundle);
if (manifest.platform !== process.platform || manifest.arch !== process.arch)
	throw new Error("Bundle platform does not match this test host");
const pgBin = process.env.TEST_PG_BIN || "/opt/homebrew/opt/postgresql@17/bin";
if (!existsSync(join(pgBin, "initdb"))) throw new Error("Set TEST_PG_BIN");
const temp = mkdtempSync("/tmp/migecast-bundle-smoke-");
const output = openSync(join(temp, "output.log"), "a", 0o600);
const data = join(temp, "database");
const children = [];
let databaseStarted = false;
let env;
async function port() {
	const server = createServer();
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const value = server.address().port;
	await new Promise((r) => server.close(r));
	return value;
}
function run(command, args, cwd = temp, expectFailure = false) {
	const result = spawnSync(command, args, {
		cwd,
		env,
		timeout: 60000,
		stdio: ["ignore", output, output],
	});
	if (
		result.error ||
		result.signal ||
		(expectFailure ? result.status === 0 : result.status !== 0)
	) {
		if (command.endsWith("/pg_ctl") && existsSync(join(temp, "postgres.log"))) {
			const startup = readFileSync(join(temp, "postgres.log"), "utf8");
			console.error(
				startup
					.split("\n")
					.filter((line) => /FATAL|ERROR|could not|invalid/.test(line))
					.slice(-4)
					.join("\n")
					.slice(0, 1200),
			);
		}
		throw new Error(
			`Release command failed its expectation: ${command.split("/").at(-1)}`,
		);
	}
}
function start(args, cwd, overrides = {}) {
	const child = spawn(process.execPath, args, {
		cwd,
		env: { ...env, ...overrides },
		stdio: ["ignore", output, output],
	});
	children.push(child);
	return child;
}
async function request(url, options = {}) {
	return fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
}
async function waitReady(url, child, headers = {}) {
	for (let attempt = 0; attempt < 60; attempt++) {
		if (child.exitCode !== null)
			throw new Error("Bundled process exited before readiness");
		try {
			if ((await request(url, { headers })).ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error("Bundled process readiness timed out");
}
try {
	const [pgPort, appPort, workerPort] = await Promise.all([
		port(),
		port(),
		port(),
	]);
	const origin = `https://127.0.0.1:${appPort}`;
	const appUrl = `http://127.0.0.1:${appPort}`;
	env = {
		PATH: process.env.PATH,
		LANG: "C",
		LC_ALL: "C",
		TZ: "UTC",
		HOME: temp,
		TMPDIR: temp,
		NODE_ENV: "production",
		NEXT_TELEMETRY_DISABLED: "1",
		DATABASE_URL: `postgresql://migecast_smoke@127.0.0.1:${pgPort}/postgres`,
		BETTER_AUTH_URL: origin,
		BETTER_AUTH_SECRET: randomBytes(48).toString("hex"),
		PLAYLIST_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
		MEDIA_WORKER_URL: `http://127.0.0.1:${workerPort}`,
		MEDIA_WORKER_SECRET: randomBytes(32).toString("hex"),
		ADMIN_USERNAME: "owner",
		ADMIN_EMAIL: "owner@example.invalid",
		ADMIN_PASSWORD: randomBytes(24).toString("hex"),
	};
	run(join(pgBin, "initdb"), [
		"-D",
		data,
		"--username=migecast_smoke",
		"--auth=trust",
		"--no-locale",
		"--encoding=UTF8",
	]);
	run(join(pgBin, "pg_ctl"), [
		"-D",
		data,
		"-l",
		join(temp, "postgres.log"),
		"-o",
		`-h 127.0.0.1 -p ${pgPort} -k ${temp}`,
		"-w",
		"start",
	]);
	databaseStarted = true;
	const operators = join(bundle, "operators");
	const migrate = ["run.mjs", "migrate"];
	if (process.platform === "linux" && process.arch === "x64") {
		// The CI image also has OpenSSL 1.1. Explicitly execute the production engine.
		const productionEngine = join(
			operators,
			"node_modules/prisma/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x",
		);
		assert.ok(
			existsSync(productionEngine),
			"Release must bundle the production OpenSSL 3 migration engine",
		);
		run(productionEngine, ["--version"], operators);
		env.PRISMA_SCHEMA_ENGINE_BINARY = productionEngine;
	}
	run(process.execPath, migrate, operators);
	run(process.execPath, migrate, operators);
	delete env.PRISMA_SCHEMA_ENGINE_BINARY;
	const bootstrap = [
		"node_modules/tsx/dist/cli.mjs",
		"scripts/create-admin.ts",
	];
	run(process.execPath, bootstrap, operators);
	run(process.execPath, bootstrap, operators, true);
	const ownerPassword = env.ADMIN_PASSWORD;
	delete env.ADMIN_PASSWORD;
	delete env.ADMIN_EMAIL;
	delete env.ADMIN_USERNAME;
	const worker = start(["dist/worker/main.js"], join(bundle, "worker"), {
		DATABASE_URL: "",
		BETTER_AUTH_SECRET: "",
		PLAYLIST_ENCRYPTION_KEY: "",
		MEDIA_WORKER_PORT: String(workerPort),
		...(process.env.FFMPEG_PATH
			? { FFMPEG_PATH: process.env.FFMPEG_PATH }
			: {}),
		...(process.env.FFPROBE_PATH
			? { FFPROBE_PATH: process.env.FFPROBE_PATH }
			: {}),
	});
	await waitReady(`${env.MEDIA_WORKER_URL}/health`, worker, {
		Authorization: `Bearer ${env.MEDIA_WORKER_SECRET}`,
	});
	assert.equal((await request(`${env.MEDIA_WORKER_URL}/health`)).status, 401);
	const app = start(["server.js"], join(bundle, "app"), {
		HOSTNAME: "127.0.0.1",
		PORT: String(appPort),
	});
	await waitReady(`${appUrl}/api/health`, app);
	const healthy = await request(`${appUrl}/api/health`);
	assert.deepEqual(await healthy.json(), { status: "ready" });
	assert.equal(healthy.headers.get("cache-control"), "no-store");
	assert.equal((await request(`${appUrl}/login`)).status, 200);
	assert.equal((await request(`${appUrl}/api/playlists`)).status, 401);
	const signedIn = await request(`${appUrl}/api/auth/sign-in/username`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: origin,
			"X-Forwarded-Proto": "https",
		},
		body: JSON.stringify({ username: "owner", password: ownerPassword }),
	});
	assert.equal(signedIn.status, 200);
	const cookies = signedIn.headers.getSetCookie();
	assert.ok(
		cookies.some(
			(cookie) => /HttpOnly/i.test(cookie) && /Secure/i.test(cookie),
		),
	);
	const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
	const session = await request(`${appUrl}/api/auth/get-session`, {
		headers: { Cookie: cookie },
	});
	assert.equal(session.status, 200);
	assert.equal((await session.json()).user.username, "owner");
	console.info(
		"Bundled migration replay, first-owner guard, standalone login, DB readiness and worker authorization passed.",
	);
	run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
	databaseStarted = false;
	const unavailable = await request(`${appUrl}/api/health`);
	assert.equal(unavailable.status, 503);
	assert.deepEqual(await unavailable.json(), { status: "unavailable" });
	console.info(
		"Database outage returned sanitized HTTP 503 within the request deadline.",
	);
} finally {
	for (const child of children.reverse()) {
		if (child.exitCode !== null) continue;
		child.kill("SIGTERM");
		await Promise.race([
			new Promise((r) => child.once("exit", r)),
			new Promise((r) => setTimeout(r, 5000)),
		]);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await new Promise((r) => child.once("exit", r));
		}
	}
	if (databaseStarted)
		run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
	closeSync(output);
	rmSync(temp, { recursive: true, force: true });
}
await verifyRelease(bundle);
console.info("Release payload integrity remains valid after runtime checks.");
