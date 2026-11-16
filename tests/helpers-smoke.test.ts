import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./helpers/auth";
import { getDb } from "@/db/postgres.db";
import { users } from "@/db/postgres.schema";
import { sessionFor } from "./helpers/auth";
import { assertLocalTestDb, resetTestDb, setupTestDb } from "./helpers/db";
import { createUser } from "./helpers/factories";

/** @info - The harness works: the real test database answers and a real token passes the real guard. */
describe("test harness", () => {
	beforeAll(async () => {
		await setupTestDb();
	});
	beforeEach(async () => {
		await resetTestDb();
	});

	it("only runs against a local database whose name ends in _test", () => {
		expect(assertLocalTestDb().endsWith("_test")).toBe(true);
	});

	it("inserts and reads a row in the real database", async () => {
		const user = await createUser({ firstName: "Harness" });
		const [row] = await getDb().select().from(users);
		expect(row?.id).toBe(user.id);
		expect(row?.firstName).toBe("Harness");
	});

	it("lets a signed token through validateToken and exposes the cached id", async () => {
		const { JwtService } = await import("@/services/jwt.service");
		const { errorHandler } = await import("@/middlewares/error");
		const user = await createUser();
		const app = new Hono();
		app.onError(errorHandler);
		app.get("/who", JwtService.getInstance().validateToken, (c) =>
			c.json({ id: (c as any).get("authData").id }),
		);
		const headers = await sessionFor(user.id);
		const ok = await app.request("/who", { headers });
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ id: user.id });
		const anonymous = await app.request("/who");
		expect(anonymous.status).toBe(401);
	});
});
