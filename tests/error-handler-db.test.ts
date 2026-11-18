/** D25 and D18: the error handler hides failed-query text and adds the code of a coded 409. */
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db/postgres.db";
import { CodedConflictError } from "@/errors";
import { errorHandler } from "@/middlewares/error";
import { setupTestDb } from "./helpers/db";
import { captureLogs } from "./helpers/log-capture";

const SENTINEL = "SENTINEL-7f3a-report-text";

describe("error handler", () => {
	let app: Hono;
	beforeAll(async () => {
		await setupTestDb();
		app = new Hono();
		app.onError(errorHandler);
		app.get("/db-fail", async () => {
			/* @info - A real failing query: Drizzle wraps it in DrizzleQueryError, whose message
			 * holds the SQL and this bound value. */
			await getDb().execute(
				sql`select ${SENTINEL}::text from "no_such_table_for_test"`,
			);
			return new Response("unreachable");
		});
		app.get("/conflict", () => {
			throw new CodedConflictError("This period is closed.", "PERIOD_CLOSED");
		});
	});

	it("answers a failed query with a generic 500 and logs only pg code, method and path", async () => {
		const logs = captureLogs();
		let res: Response;
		let text: string;
		try {
			res = await app.request("/db-fail");
			text = await res.text();
		} finally {
			logs.stop();
		}
		expect(res.status).toBe(500);
		expect(JSON.parse(text).error).toEqual({
			message: "Something went wrong. Try again.",
		});
		expect(text).not.toContain(SENTINEL);
		expect(text).not.toMatch(/select|no_such_table/i);
		expect(logs.text()).not.toContain(SENTINEL);
		expect(logs.text()).not.toMatch(/no_such_table/);
		expect(logs.text()).toContain('"pgCode":"42P01"');
		expect(logs.text()).toContain('"method":"GET"');
		expect(logs.text()).toContain('"path":"/db-fail"');
	});

	it("adds the code to a coded 409", async () => {
		const res = await app.request("/conflict");
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: unknown };
		expect(body.error).toEqual({
			message: "This period is closed.",
			code: "PERIOD_CLOSED",
		});
	});
});
