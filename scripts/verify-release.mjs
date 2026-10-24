import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const fail = (message) => {
	throw new Error(message);
};
const object = (value) =>
	value && typeof value === "object" && !Array.isArray(value);
const unsafeCharacters = (value) =>
	[...value].some(
		(char) =>
			char.charCodeAt(0) < 32 ||
			char.charCodeAt(0) === 127 ||
			char === "\\" ||
			char === ":",
	);
const boundedPath = (value) =>
	typeof value === "string" &&
	value.length > 0 &&
	!unsafeCharacters(value) &&
	!isAbsolute(value) &&
	value.split("/").every((part) => part && part !== "." && part !== "..");
const inside = (root, path) => {
	const local = relative(root, path);
	return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
};
const forbidden = (path) =>
	path
		.split("/")
		.some(
			(part) =>
				/^\.env(?:\.|$)/i.test(part) ||
				/\.(?:pem|key|p12|pfx)$/i.test(part) ||
				[
					".git",
					".npmrc",
					".netrc",
					"test-results",
					"playwright-report",
					"coverage",
					"cache",
				].includes(part),
		);

/** Verify an already extracted bundle. This does not authenticate its publisher. */
export async function verifyRelease(directory) {
	const root = await realpath(directory);
	if (!(await lstat(root)).isDirectory()) fail("Bundle must be a directory");
	const manifestPath = join(root, "release-manifest.json");
	const manifestStat = await lstat(manifestPath);
	if (!manifestStat.isFile() || manifestStat.size > 32 * 1024 * 1024)
		fail("Invalid release manifest file");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	if (
		!object(manifest) ||
		manifest.schema !== 1 ||
		!boundedPath(manifest.id) ||
		manifest.id.includes("/") ||
		typeof manifest.version !== "string" ||
		!manifest.version ||
		!/^[0-9a-f]{40}$/.test(manifest.revision) ||
		typeof manifest.dirty !== "boolean" ||
		typeof manifest.localValidationOnly !== "boolean" ||
		!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.node) ||
		typeof manifest.createdAt !== "string" ||
		!Number.isFinite(Date.parse(manifest.createdAt)) ||
		!object(manifest.dependencies) ||
		!Array.isArray(manifest.files) ||
		!Array.isArray(manifest.externalRuntimes) ||
		manifest.externalRuntimes.join(",") !== "node,ffmpeg,ffprobe"
	)
		fail("Invalid release manifest schema");
	if (
		![
			"linux",
			"darwin",
			"win32",
			"freebsd",
			"openbsd",
			"aix",
			"sunos",
			"android",
		].includes(manifest.platform) ||
		![
			"x64",
			"arm64",
			"arm",
			"ia32",
			"ppc64",
			"s390x",
			"riscv64",
			"loong64",
		].includes(manifest.arch) ||
		!(manifest.glibc === null || typeof manifest.glibc === "string")
	)
		fail("Invalid release platform");
	if (
		!manifest.localValidationOnly &&
		(manifest.platform !== "linux" ||
			manifest.arch !== "x64" ||
			!/^\d+\.\d+(?:\.\d+)?$/.test(manifest.glibc ?? "") ||
			manifest.dirty)
	)
		fail("Production release requires clean Linux x64/glibc provenance");
	const expected = new Map();
	for (const entry of manifest.files) {
		if (
			!object(entry) ||
			!boundedPath(entry.path) ||
			forbidden(entry.path) ||
			entry.path === "release-manifest.json" ||
			expected.has(entry.path)
		)
			fail("Unsafe or duplicate manifest path");
		if (Object.hasOwn(entry, "symlink")) {
			if (
				Object.keys(entry).sort().join(",") !== "path,symlink" ||
				typeof entry.symlink !== "string" ||
				!entry.symlink ||
				unsafeCharacters(entry.symlink) ||
				isAbsolute(entry.symlink) ||
				!inside(root, resolve(root, dirname(entry.path), entry.symlink))
			)
				fail("Unsafe manifest symlink");
		} else if (
			Object.keys(entry).sort().join(",") !== "bytes,path,sha256" ||
			!Number.isSafeInteger(entry.bytes) ||
			entry.bytes < 0 ||
			typeof entry.sha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(entry.sha256)
		)
			fail("Invalid manifest file entry");
		expected.set(entry.path, entry);
	}
	for (const required of [
		"app/server.js",
		"app/.next/BUILD_ID",
		"worker/dist/worker/main.js",
	])
		if (
			!expected.has(required) ||
			Object.hasOwn(expected.get(required), "symlink")
		)
			fail(`Missing release entry: ${required}`);
	const seen = new Set();
	async function visit(path, prefix = "") {
		for (const name of await readdir(path)) {
			const local = prefix ? `${prefix}/${name}` : name;
			if (local === "release-manifest.json") continue;
			const full = join(path, name);
			const stat = await lstat(full);
			if (stat.isDirectory()) {
				await visit(full, local);
				continue;
			}
			const entry = expected.get(local);
			if (!entry) fail(`Unexpected release entry: ${local}`);
			seen.add(local);
			if (Object.hasOwn(entry, "symlink")) {
				if (
					!stat.isSymbolicLink() ||
					(await readlink(full)) !== entry.symlink ||
					!inside(root, await realpath(full))
				)
					fail(`Invalid release symlink: ${local}`);
			} else {
				if (!stat.isFile() || stat.size !== entry.bytes)
					fail(`Release size or type mismatch: ${local}`);
				const hash = createHash("sha256");
				for await (const chunk of createReadStream(full)) hash.update(chunk);
				if (hash.digest("hex") !== entry.sha256)
					fail(`Release hash mismatch: ${local}`);
			}
		}
	}
	await visit(root);
	for (const path of expected.keys())
		if (!seen.has(path)) fail(`Missing release entry: ${path}`);
	return {
		id: manifest.id,
		files: seen.size,
		platform: manifest.platform,
		arch: manifest.arch,
		localValidationOnly: manifest.localValidationOnly,
	};
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		if (process.argv.length !== 3)
			fail("Usage: verify-release.mjs BUNDLE_DIRECTORY");
		console.log(JSON.stringify(await verifyRelease(process.argv[2])));
	} catch (error) {
		console.error(`Release verification failed: ${error.message}`);
		process.exitCode = 1;
	}
}
