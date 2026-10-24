import assert from "node:assert/strict";
import { loadCatalog, loadEpisodes } from "../src/server/catalog-source";

const origin = process.env.MEDIA_TEST_ORIGIN;
if (
	process.env.NODE_ENV !== "development" ||
	!origin ||
	new URL(origin).hostname !== "127.0.0.1"
)
	throw new Error("Use a local simulation origin in development only.");
const source = {
	kind: "xtream" as const,
	server: `${origin}/provider`,
	username: "fixture",
	password: "fixture",
};
const rows = await loadCatalog(source);
assert.deepEqual(
	rows.map((row) => row.kind),
	["tv", "movie", "series"],
);
assert.equal(rows[0].category, "TV");
const episodes = await loadEpisodes(source, "3", "series:3");
assert.equal(episodes.length, 1);
assert.equal(episodes[0].episode, 1);
await assert.rejects(() =>
	loadCatalog({ ...source, server: `${origin}/unavailable` }),
);
console.info(
	"Xtream catalog, lazy episodes and upstream 503 passed against local Postman simulation.",
);
