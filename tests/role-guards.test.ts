import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { requireRole as RequireRoleFn } from "@/middlewares/auth/guards";

/**
 * @info - Authorization is a database fact, not a token claim, so these tests pin the
 * guard's own lookup: a caller holding the role passes, one holding another role gets
 * 403, and an anonymous caller gets 401 before any query runs.
 *
 * postgres.db is mocked — the guard is the unit under test, not the driver.
 */
const { mockRoleRows } = vi.hoisted(() => ({
	mockRoleRows: [] as { role: string }[],
}));

vi.mock("@/db/postgres.db", () => ({
	getDb: () => ({
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => mockRoleRows }),
			}),
		}),
	}),
}));

describe("requireRole", () => {
	let requireRole: typeof RequireRoleFn;

	beforeAll(async () => {
		vi.resetModules();
		const guards = await import("@/middlewares/auth/guards");
		requireRole = guards.requireRole;
	});

	beforeEach(() => {
		mockRoleRows.length = 0;
	});

	const appWith = (guard: ReturnType<typeof requireRole>, userId?: number) => {
		const app = new Hono();
		app.use("*", (c, next) => {
			if (userId !== undefined) (c as any).set("authData", { id: userId });
			return next();
		});
		app.use("*", guard);
		app.get("/", (c) => c.text("ok"));
		return app;
	};

	it("passes when the caller holds the role", async () => {
		mockRoleRows.push({ role: "admin" });
		const res = await appWith(requireRole("admin" as never), 7).request("/");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
	});

	it("403 when the caller holds a different role", async () => {
		mockRoleRows.push({ role: "member" });
		const res = await appWith(requireRole("admin" as never), 7).request("/");
		expect(res.status).toBe(403);
	});

	it("403 when the caller holds no role at all", async () => {
		const res = await appWith(requireRole("admin" as never), 7).request("/");
		expect(res.status).toBe(403);
	});

	it("401 before any lookup when there is no session", async () => {
		const res = await appWith(requireRole("admin" as never)).request("/");
		expect(res.status).toBe(401);
	});
});
