import "./helpers/app";
import type { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/postgres.db";
import { users } from "@/db/postgres.schema";
import { buildApp, call } from "./helpers/app";
import { sessionFor } from "./helpers/auth";
import { resetTestDb, setupTestDb } from "./helpers/db";
import {
	addMember,
	createSpace,
	createUser,
	createWorkspace,
} from "./helpers/factories";

describe("GET /me/memberships and PUT /me/last-workspace", () => {
	let app: Hono;

	beforeAll(async () => {
		await setupTestDb();
		app = await buildApp();
	});
	beforeEach(async () => {
		await resetTestDb();
	});

	it("answers 401 without a token", async () => {
		const res = await call(app, "GET", "/me/memberships");
		expect(res.status).toBe(401);
	});

	it("lists two Workspaces with a different role in each (AC2)", async () => {
		const me = await createUser({ firstName: "Ada", lastName: "Obi" });
		const other = await createUser();
		const wsA = await createWorkspace(me.id, {
			name: "Alpha",
			slug: "alpha-co",
		});
		const wsB = await createWorkspace(other.id, {
			name: "Beta",
			slug: "beta-co",
		});
		await addMember(wsA.id, me.id, "admin");
		const space = await createSpace(wsB.id, "Platform");
		await addMember(wsB.id, other.id, "admin");
		await addMember(wsB.id, me.id, "staff", space.id);

		const res = await call(app, "GET", "/me/memberships", {
			headers: await sessionFor(me.id),
		});
		expect(res.status).toBe(200);
		expect(res.data.user).toEqual({
			id: String(me.id),
			name: "Ada Obi",
			email: me.email,
		});
		const roles = Object.fromEntries(
			res.data.memberships.map((m: any) => [m.workspaceId, m.role]),
		);
		expect(roles).toEqual({
			[String(wsA.id)]: "admin",
			[String(wsB.id)]: "staff",
		});
		const staffRow = res.data.memberships.find(
			(m: any) => m.workspaceId === String(wsB.id),
		);
		expect(staffRow).toMatchObject({
			space: "Platform",
			spaceId: String(space.id),
		});
		expect(res.data.workspaces.map((w: any) => w.slug).sort()).toEqual([
			"alpha-co",
			"beta-co",
		]);
		const beta = res.data.workspaces.find((w: any) => w.slug === "beta-co");
		expect(beta).toMatchObject({
			id: String(wsB.id),
			memberCount: 2,
			plan: "starter",
			memberLimit: 10,
			aiFeatures: false,
			timeZone: "UTC",
			locationTagging: false,
			readOnly: false,
		});
		expect(res.data.lastWorkspaceId).toBeNull();
	});

	it("leaves out deactivated Memberships and Workspaces the person left", async () => {
		const me = await createUser();
		const ws = await createWorkspace(me.id);
		await addMember(ws.id, me.id, "admin", null, false);
		const res = await call(app, "GET", "/me/memberships", {
			headers: await sessionFor(me.id),
		});
		expect(res.data.memberships).toEqual([]);
		expect(res.data.workspaces).toEqual([]);
	});

	it("sets and returns lastWorkspaceId, and returns null when it is stale", async () => {
		const me = await createUser();
		const ws = await createWorkspace(me.id);
		await addMember(ws.id, me.id, "admin");
		const headers = await sessionFor(me.id);
		const put = await call(app, "PUT", "/me/last-workspace", {
			headers,
			body: { workspaceId: String(ws.id) },
		});
		expect(put.status).toBe(200);
		expect(put.data).toEqual({ lastWorkspaceId: String(ws.id) });
		const after = await call(app, "GET", "/me/memberships", { headers });
		expect(after.data.lastWorkspaceId).toBe(String(ws.id));

		/* @info - The person is removed from the Workspace: the stored id is stale and must not leak. */
		const { memberships } = await import("@/db/postgres.schema");
		const { eq } = await import("drizzle-orm");
		await getDb()
			.update(memberships)
			.set({ active: false })
			.where(eq(memberships.userId, me.id));
		const stale = await call(app, "GET", "/me/memberships", { headers });
		expect(stale.data.lastWorkspaceId).toBeNull();
		const row = (
			await getDb().select().from(users).where(eq(users.id, me.id))
		)[0];
		expect(row?.lastWorkspaceId).toBe(ws.id);
	});

	it("answers 404 for a Workspace the person does not belong to (AC2)", async () => {
		const me = await createUser();
		const other = await createUser();
		const ws = await createWorkspace(other.id);
		await addMember(ws.id, other.id, "admin");
		const res = await call(app, "PUT", "/me/last-workspace", {
			headers: await sessionFor(me.id),
			body: { workspaceId: String(ws.id) },
		});
		expect(res.status).toBe(404);
		expect(res.error).toEqual({ message: "Workspace not found." });
	});

	it.each(["0", "007", "2147483648", "9999999999", "abc", ""])(
		"answers 400 for the body id %j",
		async (id) => {
			const me = await createUser();
			const res = await call(app, "PUT", "/me/last-workspace", {
				headers: await sessionFor(me.id),
				body: { workspaceId: id },
			});
			expect(res.status).toBe(400);
			expect(res.error).toHaveProperty("workspaceId");
		},
	);

	it("answers 400 for an unknown key and for a number instead of a string", async () => {
		const me = await createUser();
		const headers = await sessionFor(me.id);
		expect(
			(
				await call(app, "PUT", "/me/last-workspace", {
					headers,
					body: { workspaceId: "1", extra: true },
				})
			).status,
		).toBe(400);
		expect(
			(
				await call(app, "PUT", "/me/last-workspace", {
					headers,
					body: { workspaceId: 1 },
				})
			).status,
		).toBe(400);
	});

	it("answers 401 when the cache entry has no id (AC18)", async () => {
		const me = await createUser();
		const res = await call(app, "GET", "/me/memberships", {
			headers: await sessionFor(me.id, { omitId: true }),
		});
		expect(res.status).toBe(401);
	});

	it("answers 401 for a deleted user", async () => {
		const me = await createUser({ deletedAt: new Date() });
		const res = await call(app, "GET", "/me/memberships", {
			headers: await sessionFor(me.id),
		});
		expect(res.status).toBe(401);
	});
});
