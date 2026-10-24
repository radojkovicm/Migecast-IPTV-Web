import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { readEnvironment } from "./environment";

const globalDb = globalThis as unknown as { migecastDb?: PrismaClient };
export function getDb() {
	if (!globalDb.migecastDb) {
		globalDb.migecastDb = new PrismaClient({
			adapter: new PrismaPg({
				connectionString: readEnvironment().DATABASE_URL,
				max: 5,
			}),
		});
	}
	return globalDb.migecastDb;
}
