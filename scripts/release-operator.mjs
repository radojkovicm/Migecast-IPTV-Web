import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const commands = {
	migrate: ["node_modules/prisma/build/index.js", "migrate", "deploy"],
	"create-admin": ["node_modules/tsx/dist/cli.mjs", "scripts/create-admin.ts"],
};
const command = process.argv[2];
if (process.argv.length !== 3 || !Object.hasOwn(commands, command)) {
	console.error("Usage: node run.mjs migrate|create-admin");
	process.exit(2);
}
const [entry, ...args] = commands[command];
const result = spawnSync(process.execPath, [join(root, entry), ...args], {
	cwd: root,
	env: { ...process.env, JITI_FS_CACHE: "false" },
	stdio: "inherit",
});
if (result.error || result.signal) {
	console.error("Operator command did not complete.");
	process.exitCode = 1;
} else process.exitCode = result.status ?? 1;
