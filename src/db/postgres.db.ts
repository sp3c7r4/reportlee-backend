import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "@/config";
import * as schema from "@/db/postgres.schema";
import { logger } from "@/utils";

const pool = new Pool({
	connectionString: config.db.uri,
	max: 10,
});

let _db: ReturnType<typeof drizzle<typeof schema>>;

export const connectPostgresDB = async (server: () => void) => {
	try {
		_db = drizzle({ client: pool, schema: schema });
		await _db.execute("select 1");
		logger.info("Connected to postgres db 🐘");
		server();
	} catch (e: unknown) {
		logger.error(
			`Error connecting to PostgreSQL: ${e instanceof Error ? e.message : "Unknown error"}`,
		);
		throw e;
	}
};

export const getDb = () => {
	if (!_db) throw new Error("Database not initialized");
	return _db;
};

/** @info - The handle a transaction callback receives. Repository functions that take part in a
 * locked transaction are typed with it. */
export type Tx = Parameters<
	Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

/** @info - The pool handle typed as Tx. A pool handle and a transaction handle share one query
 * builder API, so a single set of `(tx: Tx, ...)` repository functions serves both a read outside
 * a transaction and a write inside one. */
export const getReader = (): Tx => getDb() as unknown as Tx;
