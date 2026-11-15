import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * @info - PATCH /user/:id/role through the real router, guards, Zod engine and error
 * handler. Only the edges are faked: the session lookup, the caller's role row, the
 * user and role repositories, and Redis (an in-memory map that records SET arguments).
 *
 * replaceRoleGuarded runs a transaction with an advisory lock, so its last-admin decision
 * and its concurrency guarantee cannot be exercised here. Those are marked
 * "needs verification during implementation" and are covered by the live check.
 */
const h = vi.hoisted(() => {
	const sets: { key: string; args: unknown[] }[] = [];
	const store = new Map<string, string>();
	const globToRegExp = (glob: string) =>
		new RegExp(
			`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
		);
	const redis = {
		scan: async (_cursor: string, _m: string, pattern: string) => {
			const re = globToRegExp(pattern);
			return ["0", [...store.keys()].filter((k) => re.test(k))] as [
				string,
				string[],
			];
		},
		get: async (k: string) => store.get(k) ?? null,
		call: async (cmd: string, k: string, v: string, ...args: unknown[]) => {
			if (cmd !== "SET") throw new Error(`unexpected command ${cmd}`);
			sets.push({ key: k, args });
			if (args.includes("XX") && !store.has(k)) return null;
			store.set(k, v);
			return "OK";
		},
	};
	return {
		sets,
		store,
		redis,
		callerRole: { value: "admin" as string | null },
		findById: vi.fn(),
		findMany: vi.fn(),
		replace: vi.fn(),
	};
});

vi.mock("@/db/postgres.db", () => ({
	getDb: () => ({
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () =>
						h.callerRole.value ? [{ role: h.callerRole.value }] : [],
				}),
			}),
		}),
	}),
}));

vi.mock("@/services/jwt.service", () => ({
	JwtService: {
		getInstance: () => ({
			validateToken: async (c: any, next: () => Promise<void>) => {
				const id = c.req.header("x-test-user");
				if (!id) {
					return c.json(
						{ status: 401, success: false, error: { message: "Unauthorized" } },
						401,
					);
				}
				c.set("authData", { id: Number(id), authId: `auth:${id}-1` });
				await next();
			},
		}),
	},
}));

vi.mock("@/services/cache.service", () => ({
	CacheService: {
		getInstance: () => ({
			redis: h.redis,
			get: vi.fn(),
			set: vi.fn(),
		}),
	},
}));

vi.mock("@/modules/user/user.repository", () => ({
	UserRepository: { getInstance: () => ({ findById: h.findById }) },
}));

vi.mock("@/modules/user/user-role.repository", () => ({
	UserRoleRepository: {
		getInstance: () => ({
			findMany: h.findMany,
			replaceRoleGuarded: h.replace,
		}),
	},
}));

import { Hono } from "hono";
import { errorHandler } from "@/middlewares";

const ADMIN_CALLER = "1";
const TARGET = 5;

/* @info - The first import pulls the whole services barrel, which is slow on a cold run. */
let appPromise: Promise<Hono> | undefined;
const buildApp = () => {
	/* @info - setup.ts already loaded the real guards; reset so the db mock applies (as in role-guards.test.ts). */
	vi.resetModules();
	appPromise ??= import("@/modules/user/user.routes").then(({ userRouter }) => {
		/* @info - createTestApp() registers routeNotFound as a catch-all middleware that
		 * throws before any route runs, so the real error handler is wired by hand. */
		const app = new Hono({ strict: false });
		app.onError(errorHandler);
		app.route("/user", userRouter);
		return app;
	});
	return appPromise;
};

beforeAll(async () => {
	await buildApp();
}, 180_000);

const patch = async (
	id: string | number,
	body: unknown,
	headers: Record<string, string> = { "x-test-user": ADMIN_CALLER },
) => {
	const app = await buildApp();
	return app.request(`/user/${id}/role`, {
		method: "PATCH",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
};

const session = (roles: string[]) =>
	JSON.stringify({ id: TARGET, email: "t@example.com", roles });

describe("PATCH /user/:id/role", () => {
	beforeEach(() => {
		h.sets.length = 0;
		h.store.clear();
		h.callerRole.value = "admin";
		h.findById.mockReset().mockResolvedValue({ id: TARGET });
		h.findMany.mockReset().mockResolvedValue([{ role: "member" }]);
		h.replace.mockReset().mockResolvedValue({ ok: true, previous: ["member"] });
	});

	it("401 without a token", async () => {
		const res = await patch(TARGET, { role: "admin" }, {});
		expect(res.status).toBe(401);
		expect(h.replace).not.toHaveBeenCalled();
	});

	it("403 when the caller is a member", async () => {
		h.callerRole.value = "member";
		const res = await patch(TARGET, { role: "admin" });
		expect(res.status).toBe(403);
		expect(h.replace).not.toHaveBeenCalled();
	});

	it("403 before body validation, so a member never learns the body shape", async () => {
		h.callerRole.value = "member";
		const res = await patch(TARGET, {});
		expect(res.status).toBe(403);
	});

	it("404 when the target does not exist", async () => {
		h.findById.mockResolvedValue(undefined);
		const res = await patch(999, { role: "admin" });
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(JSON.stringify(body)).toContain("User not found.");
		expect(h.replace).not.toHaveBeenCalled();
	});

	it("400 with a role field error for an empty body", async () => {
		const res = await patch(TARGET, {});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: Record<string, string> };
		expect(body.error).toHaveProperty("role");
	});

	it("400 with a role field error for an unknown role", async () => {
		const res = await patch(TARGET, { role: "root" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: Record<string, string> };
		expect(body.error).toHaveProperty("role");
	});

	it("400 for a non-numeric id", async () => {
		const res = await patch("abc", { role: "admin" });
		expect(res.status).toBe(400);
		expect(h.replace).not.toHaveBeenCalled();
	});

	it("200 promoting a member returns the documented shape", async () => {
		const res = await patch(TARGET, { role: "admin" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.success).toBe(true);
		expect(body.data.message).toBe("Role updated successfully.");
		expect(body.data.user).toEqual({
			id: TARGET,
			roles: ["admin"],
			previousRoles: ["member"],
			changed: true,
		});
		expect(h.replace).toHaveBeenCalledWith(TARGET, "admin");
	});

	it("200 changed:false for the same role, with no write and no cache write", async () => {
		h.findMany.mockResolvedValue([{ role: "admin" }]);
		h.store.set(`auth:${TARGET}-123`, session(["admin"]));
		const res = await patch(TARGET, { role: "admin" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.data.message).toBe("That user already has this role.");
		expect(body.data.user.changed).toBe(false);
		expect(h.replace).not.toHaveBeenCalled();
		expect(h.sets).toHaveLength(0);
	});

	it("400 with the last-admin message when the guard refuses", async () => {
		h.findMany.mockResolvedValue([{ role: "admin" }]);
		h.replace.mockResolvedValue({ ok: false, reason: "LAST_ADMIN" });
		h.store.set(`auth:${TARGET}-123`, session(["admin"]));
		const res = await patch(TARGET, { role: "member" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(JSON.stringify(body)).toContain(
			"There must be at least one admin. Make someone else an admin first.",
		);
		expect(h.sets).toHaveLength(0);
	});

	it("200 demoting an admin when the guard allows it", async () => {
		h.findMany.mockResolvedValue([{ role: "admin" }]);
		h.replace.mockResolvedValue({ ok: true, previous: ["admin"] });
		const res = await patch(TARGET, { role: "member" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.data.user.roles).toEqual(["member"]);
		expect(body.data.user.previousRoles).toEqual(["admin"]);
	});

	it("rewrites only the target's cached sessions, keeping TTL and never resurrecting keys", async () => {
		h.store.set(`auth:${TARGET}-123`, session(["member"]));
		h.store.set("auth:6-1", JSON.stringify({ id: 6, roles: ["member"] }));
		h.store.set(
			`auth:${TARGET}0-1`,
			JSON.stringify({ id: 50, roles: ["member"] }),
		);
		const res = await patch(TARGET, { role: "admin" });
		expect(res.status).toBe(200);

		expect(JSON.parse(h.store.get(`auth:${TARGET}-123`)!)).toMatchObject({
			email: "t@example.com",
			roles: ["admin"],
		});
		expect(JSON.parse(h.store.get("auth:6-1")!).roles).toEqual(["member"]);
		expect(JSON.parse(h.store.get(`auth:${TARGET}0-1`)!).roles).toEqual([
			"member",
		]);

		expect(h.sets).toHaveLength(1);
		expect(h.sets[0]?.key).toBe(`auth:${TARGET}-123`);
		expect(h.sets[0]?.args).toEqual(expect.arrayContaining(["XX", "KEEPTTL"]));
	});

	it("still returns 200 when the cache refresh fails", async () => {
		h.store.set(`auth:${TARGET}-123`, session(["member"]));
		const original = h.redis.scan;
		h.redis.scan = async () => {
			throw new Error("redis down");
		};
		try {
			const res = await patch(TARGET, { role: "admin" });
			expect(res.status).toBe(200);
		} finally {
			h.redis.scan = original;
		}
	});
});
