import { copyFile, cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { writePlaylist } from "./export-playlist.mjs";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("hls.js/package.json"));
await mkdir("demo/dist/vendor", { recursive: true });
await writePlaylist();
for (const file of [
	"index.html",
	"style.css",
	"app.js",
	"channels.json",
	"_headers",
])
	await copyFile(`demo/${file}`, `demo/dist/${file}`);
await cp(join(root, "dist/hls.min.js"), "demo/dist/vendor/hls.min.js");
await cp(join(root, "LICENSE"), "demo/dist/vendor/hls-LICENSE.txt");
await copyFile("LICENSE", "demo/dist/LICENSE.txt");
await copyFile("THIRD_PARTY.md", "demo/dist/THIRD_PARTY.txt");
console.log(
	"Static demo built in demo/dist. No backend or environment variables required.",
);
