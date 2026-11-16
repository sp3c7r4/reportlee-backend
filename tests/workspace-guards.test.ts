import "./helpers/auth";
import { Hono } from "hono";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { z } from "zod";
import { CodedForbiddenError, ForbiddenError } from "@/errors";
import { idString } from "@/helpers/id-schema";
import { sendSuccessResponse } from "@/helpers/response/send-response";
import { sessionFor } from "./helpers/auth";
import { resetTestDb, setupTestDb } from "./helpers/db";
import { addMember, createUser, createWorkspace } from "./helpers/factories";

/**
 * @info - The guards on a throwaway route, with the real validateToken, the real Zod engine and
 * the real database. The real `/workspaces/:wsId/*` routes repeat these cases in their own suites.
 */
describe("workspace guards", () => {
	let app: Hono;

	beforeAll(async () => {
		await setupTestDb();
		const { JwtService, ZodEngine } = await import("@/services");
		const { errorHandler } = await import("@/middlewares/error");
		const guards = await import("@/middlewares/auth/workspace-guards");
		const jwt = JwtService.getInstance();
		const zod = ZodEngine.getInstance();
		const scope = [
			jwt.validateToken,
			guards.requireCaller,
			zod.validate.params(z.object({ wsId: idString })),
			guards.requireMembership,
		];
		app = new Hono();
		app.onError(errorHandler);
		app.get("/ws/:wsId/any", ...scope, (c) =>
			c.json({ caller: c.get("caller") }),
		);
		app.post(
			"/ws/:wsId/admin",
			...scope,
			guards.requireWorkspaceRole("admin"),
			(c) => c.json({ ok: true }),
		);
		app.get("/coded", () => {
			throw new CodedForbiddenError("Verify first.", "EMAIL_NOT_VERIFIED");
		});
		app.get("/plain", () => {
			throw new ForbiddenError("Nope.");
		});
	});

	beforeEach(async () => {
		await resetTestDb();
	});

	const get = async (path: string, headers?: Record<string, string>) => {
		const res = await app.request(path, { headers });
		return { status: res.status, body: await res.json() };
	};

	it("answers 401 without a token", async () => {
		const owner = await createUser();
		const ws = await createWorkspace(owner.id);
		expect((await get(`/ws/${ws.id}/any`)).status).toBe(401);
	});

	it("answers 404 with one body for a non-member, a missing Workspace and a deactivated member", async () => {
		const owner = await createUser();
		const ws = await createWorkspace(owner.id);
		await addMember(ws.id, owner.id, "admin");
		const outsider = await createUser();
		const outsiderRes = await get(
			`/ws/${ws.id}/any`,
			await sessionFor(outsider.id),
		);
		const missing = await get(`/ws/987654/any`, await sessionFor(outsider.id));
		expect(outsiderRes.status).toBe(404);
		expect(missing.status).toBe(404);
		expect(outsiderRes.body.error).toEqual(missing.body.error);
		expect(outsiderRes.body.error.message).toBe("Workspace not found.");
	});

	it("answers 404 for a deactivated member", async () => {
		const owner = await createUser();
		const ws = await createWorkspace(owner.id);
		await addMember(ws.id, owner.id, "admin");
		const space = (await import("./helpers/factories")).createSpace;
		const sp = await space(ws.id, "Ops");
		const person = await createUser();
		await addMember(ws.id, person.id, "staff", sp.id, false);
		const res = await get(`/ws/${ws.id}/any`, await sessionFor(person.id));
		expect(res.status).toBe(404);
	});

	it("gives a platform Admin with no Membership no access (AC10)", async () => {
		const owner = await createUser();
		const ws = await createWorkspace(owner.id);
		await addMember(ws.id, owner.id, "admin");
		const platform = await createUser({ platformAdmin: true });
		const res = await get(`/ws/${ws.id}/any`, await sessionFor(platform.id));
		expect(res.status).toBe(404);
	});

	it("lets a member through and exposes the caller from the database", async () => {
		const owner = await createUser();
		const ws = await createWorkspace(owner.id);
		const m = await addMember(ws.id, owner.id, "admin");
		const res = await get(`/ws/${ws.id}/any`, await sessionFor(owner.id));
		expect(res.status).toBe(200);
		expect(res.body.caller).toMatchObject({
			membershipId: m.id,
			role: "admin",
			spaceId: null,
		});
	});

	it("answers 403 for Staff on an Admin route and ignores a role in the body", async () => {
		const owner = await createUser();
		const ws = await createWorkspace(owner.id);
		await addMember(ws.id, owner.id, "admin");
		const { createSpace } = await import("./helpers/factories");
		const sp = await createSpace(ws.id, "Ops");
		const staff = await createUser();
		await addMember(ws.id, staff.id, "staff", sp.id);
		const res = await app.request(`/ws/${ws.id}/admin`, {
			method: "POST",
			headers: {
				...(await sessionFor(staff.id)),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ role: "admin" }),
		});
		expect(res.status).toBe(403);
		const admin = await app.request(`/ws/${ws.id}/admin`, {
			method: "POST",
			headers: await sessionFor(owner.id),
		});
		expect(admin.status).toBe(200);
	});

	it("answers 401 when the cache entry carries no id (AC18)", async () => {
		const owner = await createUser();
		const ws = await createWorkspace(owner.id);
		await addMember(ws.id, owner.id, "admin");
		const res = await get(
			`/ws/${ws.id}/any`,
			await sessionFor(owner.id, { omitId: true }),
		);
		expect(res.status).toBe(401);
	});

	it("answers 401 for a deleted or suspended user", async () => {
		const { getDb } = await import("@/db/postgres.db");
		const { users } = await import("@/db/postgres.schema");
		const { eq } = await import("drizzle-orm");
		const owner = await createUser();
		const ws = await createWorkspace(owner.id);
		await addMember(ws.id, owner.id, "admin");
		await getDb()
			.update(users)
			.set({ suspendedAt: new Date() })
			.where(eq(users.id, owner.id));
		expect(
			(await get(`/ws/${ws.id}/any`, await sessionFor(owner.id))).status,
		).toBe(401);
		await getDb()
			.update(users)
			.set({ suspendedAt: null, deletedAt: new Date() })
			.where(eq(users.id, owner.id));
		expect(
			(await get(`/ws/${ws.id}/any`, await sessionFor(owner.id))).status,
		).toBe(401);
	});

	it.each(["abc", "0", "007", "2147483648", "9999999999", "-1", "1.5"])(
		"answers 400 for the id %s in the path",
		async (id) => {
			const owner = await createUser();
			const res = await get(`/ws/${id}/any`, await sessionFor(owner.id));
			expect(res.status).toBe(400);
		},
	);

	it("adds a code to a coded 403 and nothing to a plain 403", async () => {
		const coded = await get("/coded");
		expect(coded.status).toBe(403);
		expect(coded.body.error).toEqual({
			message: "Verify first.",
			code: "EMAIL_NOT_VERIFIED",
		});
		const plain = await get("/plain");
		expect(plain.status).toBe(403);
		expect(plain.body.error).toEqual({ message: "Nope." });
	});
});

describe("sendSuccessResponse log option (D29)", () => {
	let log: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		log = vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => log.mockRestore());

	const run = async (options?: { log?: boolean }) => {
		const app = new Hono();
		app.get("/x", (c) =>
			options === undefined
				? sendSuccessResponse(c, { who: "ada@example.com" })
				: sendSuccessResponse(c, { who: "ada@example.com" }, 200, options),
		);
		const res = await app.request("/x");
		return { status: res.status, body: await res.json() };
	};

	it("still logs for existing callers", async () => {
		const res = await run();
		expect(res.body.data).toEqual({ who: "ada@example.com" });
		expect(log).toHaveBeenCalledWith("Response: ", { who: "ada@example.com" });
	});

	it("does not log with { log: false } and still returns the body", async () => {
		const res = await run({ log: false });
		expect(res.body.data).toEqual({ who: "ada@example.com" });
		expect(log).not.toHaveBeenCalled();
	});
});
