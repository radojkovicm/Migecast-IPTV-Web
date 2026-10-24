import { createHash } from "node:crypto";
import {
	copyFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function allowed(path) {
	return !path
		.split(/[\\/]/)
		.some(
			(part) =>
				part === "node_modules" ||
				part === ".git" ||
				part === ".npmrc" ||
				part === ".netrc" ||
				/^\.env(?:\.|$)/i.test(part) ||
				/\.(pem|key|p12|pfx)$/i.test(part),
		);
}

async function copyTree(source, destination, boundary = source) {
	const local = relative(boundary, source);
	if (!allowed(local)) return;
	const stat = await lstat(source);
	if (stat.isSymbolicLink()) {
		const target = await realpath(source);
		const targetLocal = relative(boundary, target);
		if (
			isAbsolute(targetLocal) ||
			targetLocal === ".." ||
			targetLocal.startsWith(`..${sep}`) ||
			!allowed(targetLocal)
		)
			throw new Error(`Unsafe operator asset link: ${local}`);
		await symlink(relative(dirname(local), targetLocal), destination);
	} else if (stat.isDirectory()) {
		await mkdir(destination, { recursive: true });
		for (const name of (await readdir(source)).sort())
			await copyTree(join(source, name), join(destination, name), boundary);
	} else if (stat.isFile()) {
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(source, destination);
	} else throw new Error(`Unsupported operator asset: ${local}`);
}

async function resolvePackage(name, from) {
	if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name))
		throw new Error(`Invalid dependency name: ${name}`);
	let directory = resolve(from);
	while (true) {
		const candidate = join(directory, "node_modules", name);
		try {
			await lstat(join(candidate, "package.json"));
			return await realpath(candidate);
		} catch (error) {
			if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
		}
		const parent = dirname(directory);
		if (parent === directory) return null;
		directory = parent;
	}
}

// Reconstruct pnpm's dependency graph without retaining checkout/store links.
export async function packageDependencyClosure(root, destination, names) {
	const visited = new Map();
	await mkdir(destination, { recursive: true });
	async function include(name, from, linkDirectory, optional = false) {
		const source = await resolvePackage(name, from);
		if (!source) {
			if (optional) return;
			throw new Error(`Missing required operator dependency: ${name}`);
		}
		let target = visited.get(source);
		const fresh = !target;
		if (fresh) {
			const id = createHash("sha256").update(source).digest("hex").slice(0, 24);
			target = join(destination, ".operator-store", id);
			visited.set(source, target);
			await copyTree(source, target);
		}
		const link = join(linkDirectory, name);
		await mkdir(dirname(link), { recursive: true });
		await symlink(relative(dirname(link), target), link);
		if (!fresh) return;
		const pkg = JSON.parse(
			await readFile(join(source, "package.json"), "utf8"),
		);
		const dependencies = {
			...pkg.peerDependencies,
			...pkg.dependencies,
			...pkg.optionalDependencies,
		};
		for (const dependency of Object.keys(dependencies).sort()) {
			const optional =
				Object.hasOwn(pkg.optionalDependencies ?? {}, dependency) ||
				(!Object.hasOwn(pkg.dependencies ?? {}, dependency) &&
					pkg.peerDependenciesMeta?.[dependency]?.optional === true);
			await include(dependency, source, join(target, "node_modules"), optional);
		}
	}
	for (const name of [...new Set(names)].sort())
		await include(name, root, destination);
	return visited.size;
}

export async function packageOperatorTools(root, bundle) {
	const destination = join(bundle, "operators");
	await mkdir(destination, { recursive: true });
	for (const path of [
		"prisma.config.ts",
		"prisma",
		"scripts/create-admin.ts",
		"src/server/password.ts", // gitleaks:allow -- Source filename, not a credential.
		"src/generated/prisma",
	]) {
		await copyTree(join(root, path), join(destination, path));
	}
	await writeFile(
		join(destination, "package.json"),
		`${JSON.stringify({ name: "migecast-release-operators", private: true, type: "module" }, null, 2)}\n`,
	);
	return packageDependencyClosure(root, join(destination, "node_modules"), [
		"prisma",
		"tsx",
		"@prisma/adapter-pg",
		"@prisma/client",
		"@node-rs/argon2",
		"zod",
	]);
}
