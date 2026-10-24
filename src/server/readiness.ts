import { Pool } from "pg";

let pool: Pool | undefined;

/** A separate bounded pool keeps monitoring independent of playback traffic. */
export async function readinessResponse() {
	try {
		if (!process.env.DATABASE_URL) throw new Error("Not configured");
		pool ??= new Pool({
			connectionString: process.env.DATABASE_URL,
			max: 1,
			connectionTimeoutMillis: 1500,
			query_timeout: 1500,
			statement_timeout: 1500,
			idleTimeoutMillis: 1000,
			allowExitOnIdle: true,
		});
		// Idle connection failures must not become uncaught EventEmitter errors.
		if (pool.listenerCount("error") === 0) pool.on("error", () => {});
		await pool.query("SELECT 1");
		return Response.json(
			{ status: "ready" },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch {
		return Response.json(
			{ status: "unavailable" },
			{ status: 503, headers: { "Cache-Control": "no-store" } },
		);
	}
}
