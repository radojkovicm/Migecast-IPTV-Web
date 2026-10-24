import assert from "node:assert/strict";
import { Client } from "pg";
import { decryptPlaylist } from "../src/server/playlist-crypto";

const urls = [process.env.DATABASE_URL, process.env.TEST_RESTORE_DATABASE_URL];
for (const value of urls) {
	const url = new URL(value ?? "");
	assert.equal(url.hostname, "127.0.0.1");
	assert.equal(url.username, "migecast_test");
	assert.ok(["/postgres", "/restore_check"].includes(url.pathname));
}
const clients = urls.map(
	(connectionString) => new Client({ connectionString }),
);
try {
	await Promise.all(clients.map((client) => client.connect()));
	for (const table of [
		"user",
		"playlist",
		"catalogItem",
		"viewingState",
		"_prisma_migrations",
	]) {
		const results = await Promise.all(
			clients.map((client) =>
				client.query(
					`SELECT count(*)::int AS count, md5(string_agg(row_to_json(t)::text, ',' ORDER BY row_to_json(t)::text)) AS digest FROM "${table}" t`,
				),
			),
		);
		assert.deepEqual(
			results[0].rows,
			results[1].rows,
			`${table}: restored data differs`,
		);
		assert.ok(results[0].rows[0].count > 0, `${table}: missing fixture data`);
	}
	const result = await clients[1].query(
		'SELECT id, "encryptedInput" FROM playlist LIMIT 1',
	);
	assert.ok(decryptPlaylist(result.rows[0].id, result.rows[0].encryptedInput));
	console.info(
		"Scratch PostgreSQL backup/restore: row digests and source decryption passed.",
	);
} finally {
	await Promise.all(clients.map((client) => client.end()));
}
