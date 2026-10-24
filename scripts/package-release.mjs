import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cp,
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	realpath,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { packageOperatorTools } from "./package-operator.mjs";

export function allowedPath(path) {
	return !path
		.split(/[\\/]/)
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
}

export async function inventory(root) {
	root = await realpath(root);
	const files = [];
	async function visit(directory) {
		for (const name of (await readdir(directory)).sort()) {
			const path = join(directory, name);
			const local = relative(root, path).split(sep).join("/");
			if (!allowedPath(local))
				throw new Error(`Forbidden release path: ${local}`);
			const stat = await lstat(path);
			if (stat.isSymbolicLink()) {
				const target = await readlink(path);
				const resolved = relative(root, await realpath(path));
				if (
					isAbsolute(target) ||
					resolved === ".." ||
					resolved.startsWith(`..${sep}`) ||
					isAbsolute(resolved)
				)
					throw new Error(`Non-relocatable release link: ${local}`);
				files.push({ path: local, symlink: target });
			} else if (stat.isDirectory()) await visit(path);
			else if (stat.isFile())
				files.push({
					path: local,
					bytes: stat.size,
					sha256: createHash("sha256")
						.update(await readFile(path))
						.digest("hex"),
				});
			else throw new Error(`Unsupported release entry: ${local}`);
		}
	}
	await visit(root);
	return files;
}

export async function packageRelease({
	root = process.cwd(),
	output,
	local = false,
} = {}) {
	if (
		!local &&
		(process.platform !== "linux" ||
			process.arch !== "x64" ||
			!process.report.getReport().header.glibcVersionRuntime)
	)
		throw new Error(
			"Production packaging requires Linux x64/glibc. Use --local only for a platform-labelled validation bundle.",
		);
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	const revision = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	const dirty = Boolean(
		execFileSync("git", ["status", "--porcelain"], {
			cwd: root,
			encoding: "utf8",
		}).trim(),
	);
	if (!local && dirty)
		throw new Error("Production packaging requires a clean checkout.");
	const id = `${pkg.name}-${pkg.version}-${revision.slice(0, 12)}-${process.platform}-${process.arch}${local ? "-local" : ""}`;
	const destination = resolve(output || join(root, "build", "releases"));
	await mkdir(destination, { recursive: true });
	const bundle = join(destination, id);
	await mkdir(bundle); // Never overwrite an existing candidate.
	const copy = (from, to) =>
		cp(join(root, from), join(bundle, to), {
			recursive: true,
			verbatimSymlinks: true,
			filter: (path) => allowedPath(relative(root, path)),
		});
	await copy(".next/standalone", "app");
	await copy(".next/static", "app/.next/static");
	try {
		await copy("public", "app/public");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	for (const file of ["main.js", "plan.js", "config.js"])
		await copy(`dist/worker/${file}`, `worker/dist/worker/${file}`);
	await copy(
		"dist/src/server/provider-http.js",
		"worker/dist/src/server/provider-http.js",
	);
	await writeFile(
		join(bundle, "worker/package.json"),
		JSON.stringify(
			{
				name: `${pkg.name}-worker`,
				version: pkg.version,
				private: true,
				type: "module",
			},
			null,
			2,
		),
	);
	const require = createRequire(join(root, "package.json"));
	for (const name of ["ipaddr.js", "zod"]) {
		let directory = dirname(require.resolve(name));
		while (true) {
			try {
				const metadata = JSON.parse(
					await readFile(join(directory, "package.json"), "utf8"),
				);
				if (metadata.name === name) {
					if (Object.keys(metadata.dependencies || {}).length)
						throw new Error(`Review worker dependency closure for ${name}`);
					await cp(directory, join(bundle, "worker/node_modules", name), {
						recursive: true,
						filter: (path) => allowedPath(relative(directory, path)),
					});
					break;
				}
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			const parent = dirname(directory);
			if (parent === directory)
				throw new Error(`Missing package metadata: ${name}`);
			directory = parent;
		}
	}
	await copy(
		"deploy/systemd/check-runtime.sh",
		"worker/deploy/systemd/check-runtime.sh",
	);
	await copy("prisma/migrations", "database/migrations");
	await copy("prisma/schema.prisma", "database/schema.prisma");
	await copy("pnpm-lock.yaml", "provenance/pnpm-lock.yaml");
	await packageOperatorTools(root, bundle);
	await copy("scripts/release-operator.mjs", "operators/run.mjs");
	await copy("deploy", "deployment");
	for (const name of [
		"MANUAL_DEPLOYMENT.md",
		"WORKER_DEPLOYMENT.md",
		"RELEASE_BUNDLE.md",
		"READINESS.md",
	])
		await copy(`docs/${name}`, `docs/${name}`);
	await copy("scripts/verify-release.mjs", "verify-release.mjs");
	const files = await inventory(bundle);
	if (!local) {
		for (const file of files.filter(
			(file) => file.path.endsWith(".node") && file.sha256,
		)) {
			const binary = await readFile(join(bundle, file.path));
			if (
				binary.length < 20 ||
				binary.subarray(0, 4).toString("hex") !== "7f454c46" ||
				binary[4] !== 2 ||
				binary[5] !== 1 ||
				binary.readUInt16LE(18) !== 62
			)
				throw new Error(`Native addon is not Linux x64: ${file.path}`);
		}
	}

	for (const required of [
		"app/server.js",
		"app/.next/BUILD_ID",
		"worker/dist/worker/main.js",
	])
		if (!files.some((file) => file.path === required))
			throw new Error(`Missing release entry: ${required}`);
	const manifest = {
		schema: 1,
		id,
		version: pkg.version,
		revision,
		dirty,
		localValidationOnly: local,
		platform: process.platform,
		arch: process.arch,
		node: process.version,
		glibc: process.report.getReport().header.glibcVersionRuntime || null,
		createdAt: new Date().toISOString(),
		dependencies: pkg.dependencies,
		externalRuntimes: ["node", "ffmpeg", "ffprobe"],
		files,
	};
	await writeFile(
		join(bundle, "release-manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	const archive = `${bundle}.tar.gz`;
	execFileSync("tar", ["-czf", archive, "-C", destination, id], {
		env: { ...process.env, COPYFILE_DISABLE: "1" },
	});
	const digest = createHash("sha256")
		.update(await readFile(archive))
		.digest("hex");
	await writeFile(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
	return { archive, files: files.length, localValidationOnly: local };
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const args = process.argv.slice(2);
	if (args.some((arg) => arg !== "--local"))
		throw new Error("Usage: package-release.mjs [--local]");
	console.log(
		JSON.stringify(await packageRelease({ local: args.includes("--local") })),
	);
}
