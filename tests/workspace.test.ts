import "./helpers/app";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { RESERVED_SLUGS } from "@/constants/reserved-slugs";
import { getDb } from "@/db/postgres.db";
import {
	audit_logs,
	memberships,
	users,
	workspaces,
} from "@/db/postgres.schema";
import { buildApp, call } from "./helpers/app";
import { sessionFor } from "./helpers/auth";
import { resetTestDb, setupTestDb } from "./helpers/db";
import {
	addMember,
	createSpace,
	createTeam,
	createUser,
	createWorkspace,
} from "./helpers/factories";

describe("workspaces", () => {
	let app: Hono;

	beforeAll(async () => {
		await setupTestDb();
		app = await buildApp();
	});
	beforeEach(async () => {
		await resetTestDb();
	});
	afterEach(() => vi.restoreAllMocks());

	const create = async (userId: number, body: unknown, opts = {}) =>
		call(app, "POST", "/workspaces", {
			headers: await sessionFor(userId, opts),
			body,
		});

	describe("POST /workspaces", () => {
		it("creates the Workspace and makes the caller its only active Admin (AC1)", async () => {
			const me = await createUser();
			const res = await create(me.id, {
				name: "Acme Ops",
				slug: "acme-ops",
				timeZone: "Africa/Lagos",
			});
			expect(res.status).toBe(201);
			expect(res.data.workspace).toMatchObject({
				name: "Acme Ops",
				slug: "acme-ops",
				memberCount: 1,
				plan: "starter",
				memberLimit: 10,
				aiFeatures: false,
				timeZone: "Africa/Lagos",
				locationTagging: false,
				readOnly: false,
			});
			expect(typeof res.data.workspace.id).toBe("string");
			expect(res.data.membership).toMatchObject({
				userId: String(me.id),
				workspaceId: res.data.workspace.id,
				role: "admin",
				space: null,
				spaceId: null,
			});
			const rows = await getDb().select().from(memberships);
			expect(rows).toHaveLength(1);
			const [user] = await getDb()
				.select()
				.from(users)
				.where(eq(users.id, me.id));
			expect(String(user?.lastWorkspaceId)).toBe(res.data.workspace.id);
			const audit = await getDb().select().from(audit_logs);
			expect(audit.map((a) => a.action)).toEqual(["workspace.created"]);
			expect(audit[0]?.summary).not.toContain(me.email);
		});

		it("defaults the time zone to UTC", async () => {
			const me = await createUser();
			const res = await create(me.id, { name: "Acme Ops", slug: "acme-ops" });
			expect(res.data.workspace.timeZone).toBe("UTC");
		});

		it("returns field errors for a bad body", async () => {
			const me = await createUser();
			const res = await create(me.id, { name: "A", slug: "x" });
			expect(res.status).toBe(400);
			expect(res.error).toHaveProperty("name");
			expect(res.error).toHaveProperty("slug");
			expect(await getDb().select().from(workspaces)).toHaveLength(0);
		});

		it.each(["www", "admin", "login"])(
			"refuses the reserved slug %s with a field error",
			async (slug) => {
				const me = await createUser();
				const res = await create(me.id, { name: "Acme Ops", slug });
				expect(res.status).toBe(400);
				expect(res.error).toHaveProperty("slug");
			},
		);

		it.each(["-bad-", "a--b", "Has-Upper", "has space", "ab", "a".repeat(33)])(
			"refuses the malformed slug %j",
			async (slug) => {
				const me = await createUser();
				const res = await create(me.id, { name: "Acme Ops", slug });
				expect(res.status).toBe(400);
				expect(res.error).toHaveProperty("slug");
			},
		);

		it("answers 409 for a taken slug in any case", async () => {
			const first = await createUser();
			await create(first.id, { name: "One", slug: "acme-ops" });
			const second = await createUser();
			const res = await create(second.id, { name: "Two", slug: "acme-ops" });
			expect(res.status).toBe(409);
			expect(res.error).toEqual({ message: "That address is already taken." });
			const upper = await create(second.id, { name: "Two", slug: "ACME-OPS" });
			expect([400, 409]).toContain(upper.status);
			expect(await getDb().select().from(workspaces)).toHaveLength(1);
		});

		it("answers 409 for two simultaneous creates of one slug", async () => {
			const a = await createUser();
			const b = await createUser();
			const [r1, r2] = await Promise.all([
				create(a.id, { name: "One", slug: "race-co" }),
				create(b.id, { name: "Two", slug: "race-co" }),
			]);
			expect([r1.status, r2.status].sort()).toEqual([201, 409]);
			expect(await getDb().select().from(workspaces)).toHaveLength(1);
		});

		it("answers 403 EMAIL_NOT_VERIFIED for an unverified user and creates nothing", async () => {
			const me = await createUser({ emailVerified: false });
			const res = await create(me.id, { name: "Acme Ops", slug: "acme-ops" });
			expect(res.status).toBe(403);
			expect(res.error.code).toBe("EMAIL_NOT_VERIFIED");
			expect(await getDb().select().from(workspaces)).toHaveLength(0);
		});

		it("reads verified state from the user row, not the stale cache (AC18)", async () => {
			const me = await createUser({ emailVerified: false });
			const res = await create(
				me.id,
				{ name: "Acme Ops", slug: "acme-ops" },
				{ emailVerified: true },
			);
			expect(res.status).toBe(403);
			expect(res.error).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
		});

		it("answers 401 for a deleted user", async () => {
			const me = await createUser({ deletedAt: new Date() });
			const res = await create(me.id, { name: "Acme Ops", slug: "acme-ops" });
			expect(res.status).toBe(401);
		});

		it("rejects an unknown key", async () => {
			const me = await createUser();
			const res = await create(me.id, {
				name: "Acme Ops",
				slug: "acme-ops",
				plan: "enterprise",
			});
			expect(res.status).toBe(400);
		});

		it("is atomic: a failing audit write leaves no Workspace (AC14)", async () => {
			const { AuditLogService } = await import(
				"@/modules/audit/audit-log.service"
			);
			vi.spyOn(AuditLogService.getInstance(), "record").mockRejectedValue(
				new Error("audit down"),
			);
			const me = await createUser();
			const res = await create(me.id, { name: "Acme Ops", slug: "acme-ops" });
			expect(res.status).toBe(500);
			expect(await getDb().select().from(workspaces)).toHaveLength(0);
			expect(await getDb().select().from(memberships)).toHaveLength(0);
		});
	});

	describe("GET /workspaces/slug-available", () => {
		const check = async (userId: number, slug?: string) =>
			call(
				app,
				"GET",
				`/workspaces/slug-available${slug === undefined ? "" : `?slug=${encodeURIComponent(slug)}`}`,
				{
					headers: await sessionFor(userId),
				},
			);

		it("answers available, taken, reserved and invalid", async () => {
			const me = await createUser();
			await createWorkspace(me.id, { slug: "taken-co" });
			expect((await check(me.id, "free-co")).data).toEqual({ available: true });
			expect((await check(me.id, "TAKEN-co")).data).toEqual({
				available: false,
				reason: "taken",
			});
			expect((await check(me.id, "admin")).data).toEqual({
				available: false,
				reason: "reserved",
			});
			expect((await check(me.id, "-no-")).data).toEqual({
				available: false,
				reason: "invalid",
			});
		});

		it("answers 400 when slug is missing and 401 without a token", async () => {
			const me = await createUser();
			expect((await check(me.id)).status).toBe(400);
			const anon = await call(
				app,
				"GET",
				"/workspaces/slug-available?slug=abc",
			);
			expect(anon.status).toBe(401);
		});
	});

	describe("GET and PATCH /workspaces/:wsId", () => {
		it("returns the Workspace to any member with the documented shape", async () => {
			const t = await createTeam();
			for (const user of [t.admin, t.headUser, t.staffUser]) {
				const res = await call(app, "GET", `/workspaces/${t.workspace.id}`, {
					headers: await sessionFor(user.id),
				});
				expect(res.status).toBe(200);
				expect(res.data).toMatchObject({
					id: String(t.workspace.id),
					memberCount: 3,
					plan: "starter",
				});
			}
		});

		it("answers 404 for another Workspace and for a platform Admin without a Membership (AC3, AC10)", async () => {
			const t = await createTeam();
			const other = await createTeam();
			const cross = await call(
				app,
				"GET",
				`/workspaces/${other.workspace.id}`,
				{
					headers: await sessionFor(t.admin.id),
				},
			);
			expect(cross.status).toBe(404);
			const platform = await createUser({ platformAdmin: true });
			const res = await call(app, "GET", `/workspaces/${t.workspace.id}`, {
				headers: await sessionFor(platform.id),
			});
			expect(res.status).toBe(404);
		});

		it("lets an Admin change name, time zone and location tagging, and writes an audit row", async () => {
			const t = await createTeam();
			const res = await call(app, "PATCH", `/workspaces/${t.workspace.id}`, {
				headers: await sessionFor(t.admin.id),
				body: {
					name: "Renamed",
					timeZone: "Europe/London",
					locationTagging: true,
				},
			});
			expect(res.status).toBe(200);
			expect(res.data).toMatchObject({
				name: "Renamed",
				timeZone: "Europe/London",
				locationTagging: true,
				slug: t.workspace.slug,
			});
			const audit = await getDb().select().from(audit_logs);
			expect(audit.map((a) => a.action)).toContain("workspace.updated");
		});

		it("answers 403 for Staff and for a Head", async () => {
			const t = await createTeam();
			for (const user of [t.staffUser, t.headUser]) {
				const res = await call(app, "PATCH", `/workspaces/${t.workspace.id}`, {
					headers: await sessionFor(user.id),
					body: { name: "Nope" },
				});
				expect(res.status).toBe(403);
			}
			const [row] = await getDb()
				.select()
				.from(workspaces)
				.where(eq(workspaces.id, t.workspace.id));
			expect(row?.name).toBe(t.workspace.name);
		});

		it("rejects slug, plan, aiFeatures, an empty body and bad values", async () => {
			const t = await createTeam();
			const headers = await sessionFor(t.admin.id);
			for (const body of [
				{ slug: "new-slug" },
				{ plan: "enterprise" },
				{ aiFeatures: true },
				{},
				{ name: "A" },
				{ timeZone: "Mars/Base" },
			]) {
				const res = await call(app, "PATCH", `/workspaces/${t.workspace.id}`, {
					headers,
					body,
				});
				expect(res.status, JSON.stringify(body)).toBe(400);
			}
			const [row] = await getDb()
				.select()
				.from(workspaces)
				.where(eq(workspaces.id, t.workspace.id));
			expect(row?.slug).toBe(t.workspace.slug);
		});

		it("answers 404 for a non-member and 400 for a malformed id", async () => {
			const t = await createTeam();
			const outsider = await createUser();
			const headers = await sessionFor(outsider.id);
			expect(
				(
					await call(app, "PATCH", `/workspaces/${t.workspace.id}`, {
						headers,
						body: { name: "Nope" },
					})
				).status,
			).toBe(404);
			expect(
				(await call(app, "GET", "/workspaces/abc", { headers })).status,
			).toBe(400);
		});
	});

	describe("shared data", () => {
		it("keeps the reserved slug list equal to the frontend list (AC9)", () => {
			const file = join(
				__dirname,
				"..",
				"..",
				"reportlee-frontend",
				"src",
				"lib",
				"onboarding.ts",
			);
			let text: string;
			try {
				text = readFileSync(file, "utf-8");
			} catch {
				return; // sibling repo not checked out next to this one
			}
			const block =
				/RESERVED_SLUGS: readonly string\[\] = \[([\s\S]*?)\]/.exec(
					text,
				)?.[1] ?? "";
			const frontend = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
			expect(frontend.length).toBeGreaterThan(0);
			expect([...RESERVED_SLUGS]).toEqual(frontend);
		});

		it("does not count a deleted Admin as a member", async () => {
			const t = await createTeam();
			await getDb()
				.update(users)
				.set({ deletedAt: new Date() })
				.where(eq(users.id, t.headUser.id));
			const res = await call(app, "GET", `/workspaces/${t.workspace.id}`, {
				headers: await sessionFor(t.admin.id),
			});
			expect(res.data.memberCount).toBe(2);
			void createSpace;
			void addMember;
		});
	});
});
