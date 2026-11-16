import "./helpers/app";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/postgres.db";
import { audit_logs, memberships, spaces } from "@/db/postgres.schema";
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

describe("spaces", () => {
	let app: Hono;

	beforeAll(async () => {
		await setupTestDb();
		app = await buildApp();
	});
	beforeEach(async () => {
		await resetTestDb();
	});

	const as = async (userId: number) => ({ headers: await sessionFor(userId) });
	const base = (wsId: number) => `/workspaces/${wsId}/spaces`;
	const actions = async () =>
		(await getDb().select().from(audit_logs)).map((a) => a.action);

	describe("GET", () => {
		it("lists Spaces for every member with the documented shape", async () => {
			const t = await createTeam();
			for (const user of [t.admin, t.headUser, t.staffUser]) {
				const res = await call(
					app,
					"GET",
					base(t.workspace.id),
					await as(user.id),
				);
				expect(res.status).toBe(200);
				expect(res.data).toEqual([
					{
						id: String(t.space.id),
						name: "Platform",
						headMembershipId: String(t.headM.id),
						archived: false,
						kpiTemplate: [],
						memberCount: 2,
					},
				]);
			}
		});

		it("answers 404 for a foreign Workspace and 401 without a token", async () => {
			const t = await createTeam();
			const other = await createTeam();
			expect(
				(await call(app, "GET", base(other.workspace.id), await as(t.admin.id)))
					.status,
			).toBe(404);
			expect((await call(app, "GET", base(t.workspace.id))).status).toBe(401);
		});
	});

	describe("POST", () => {
		it("lets an Admin create a Space and writes an audit row", async () => {
			const t = await createTeam();
			const res = await call(app, "POST", base(t.workspace.id), {
				...(await as(t.admin.id)),
				body: { name: "  Finance  " },
			});
			expect(res.status).toBe(201);
			expect(res.data).toMatchObject({
				name: "Finance",
				headMembershipId: null,
				archived: false,
				kpiTemplate: [],
				memberCount: 0,
			});
			expect(await actions()).toContain("space.created");
		});

		it("answers 409 for a name clash in any case", async () => {
			const t = await createTeam();
			const res = await call(app, "POST", base(t.workspace.id), {
				...(await as(t.admin.id)),
				body: { name: "PLATFORM" },
			});
			expect(res.status).toBe(409);
			expect(res.error).toEqual({ message: "PLATFORM is already a Space." });
		});

		it("answers 403 for Staff and Head, 400 for a bad body", async () => {
			const t = await createTeam();
			for (const user of [t.staffUser, t.headUser]) {
				const res = await call(app, "POST", base(t.workspace.id), {
					...(await as(user.id)),
					body: { name: "Finance" },
				});
				expect(res.status).toBe(403);
			}
			const admin = await as(t.admin.id);
			for (const body of [
				{},
				{ name: "" },
				{ name: "x".repeat(81) },
				{ name: "A", extra: 1 },
			]) {
				const res = await call(app, "POST", base(t.workspace.id), {
					...admin,
					body,
				});
				expect(res.status, JSON.stringify(body)).toBe(400);
			}
		});

		it("answers 422 for the 51st Space", async () => {
			const t = await createTeam();
			for (let i = 0; i < 49; i++)
				await createSpace(t.workspace.id, `Extra ${i}`);
			const res = await call(app, "POST", base(t.workspace.id), {
				...(await as(t.admin.id)),
				body: { name: "One too many" },
			});
			expect(res.status).toBe(422);
		});
	});

	describe("PATCH", () => {
		const patch = async (
			userId: number,
			wsId: number,
			spaceId: number | string,
			body: unknown,
		) =>
			call(app, "PATCH", `${base(wsId)}/${spaceId}`, {
				...(await as(userId)),
				body,
			});

		it("renames, restores and sets the KPI template as Admin, with audit rows (AC14)", async () => {
			const t = await createTeam();
			const template = [{ name: "Tickets closed", unit: "count" }];
			const res = await patch(t.admin.id, t.workspace.id, t.space.id, {
				name: "Platform Eng",
				kpiTemplate: template,
			});
			expect(res.status).toBe(200);
			expect(res.data).toMatchObject({
				name: "Platform Eng",
				kpiTemplate: template,
			});
			expect(await actions()).toContain("space.updated");
		});

		it("answers 409 when renaming onto another Space in any case", async () => {
			const t = await createTeam();
			await createSpace(t.workspace.id, "Finance");
			const res = await patch(t.admin.id, t.workspace.id, t.space.id, {
				name: "FINANCE",
			});
			expect(res.status).toBe(409);
		});

		it("refuses to archive a Space with members (AC8) and archives an empty one", async () => {
			const t = await createTeam();
			const blocked = await patch(t.admin.id, t.workspace.id, t.space.id, {
				archived: true,
			});
			expect(blocked.status).toBe(409);
			expect(blocked.error.message).toBe(
				"Move its members out before archiving this Space.",
			);
			const empty = await createSpace(t.workspace.id, "Empty");
			const ok = await patch(t.admin.id, t.workspace.id, empty.id, {
				archived: true,
			});
			expect(ok.status).toBe(200);
			expect(ok.data.archived).toBe(true);
			expect(await actions()).toContain("space.archived");
			const restored = await patch(t.admin.id, t.workspace.id, empty.id, {
				archived: false,
			});
			expect(restored.data.archived).toBe(false);
		});

		it("lets a Head edit the template of their own Space only (AC13)", async () => {
			const t = await createTeam();
			const template = [{ name: "Deploys", unit: "count" }];
			const own = await patch(t.headUser.id, t.workspace.id, t.space.id, {
				kpiTemplate: template,
			});
			expect(own.status).toBe(200);
			expect(own.data.kpiTemplate).toEqual(template);
			const otherSpace = await createSpace(t.workspace.id, "Finance");
			const foreign = await patch(
				t.headUser.id,
				t.workspace.id,
				otherSpace.id,
				{
					kpiTemplate: template,
				},
			);
			expect(foreign.status).toBe(403);
		});

		it("answers 403 when a Head sends any other key", async () => {
			const t = await createTeam();
			for (const body of [
				{ name: "Renamed" },
				{ archived: true },
				{ headMembershipId: null },
				{ name: "Renamed", kpiTemplate: [] },
			]) {
				const res = await patch(
					t.headUser.id,
					t.workspace.id,
					t.space.id,
					body,
				);
				expect(res.status, JSON.stringify(body)).toBe(403);
			}
			const [row] = await getDb()
				.select()
				.from(spaces)
				.where(eq(spaces.id, t.space.id));
			expect(row?.name).toBe("Platform");
			expect(row?.headMembershipId).toBe(t.headM.id);
		});

		it("answers 403 for Staff", async () => {
			const t = await createTeam();
			const res = await patch(t.staffUser.id, t.workspace.id, t.space.id, {
				name: "Nope",
			});
			expect(res.status).toBe(403);
		});

		it("answers 404 for a Space of another Workspace, and for a foreign Workspace", async () => {
			const t = await createTeam();
			const other = await createTeam();
			expect(
				(
					await patch(t.admin.id, t.workspace.id, other.space.id, {
						name: "Hijack",
					})
				).status,
			).toBe(404);
			expect(
				(
					await patch(t.admin.id, other.workspace.id, other.space.id, {
						name: "Hijack",
					})
				).status,
			).toBe(404);
			const [row] = await getDb()
				.select()
				.from(spaces)
				.where(eq(spaces.id, other.space.id));
			expect(row?.name).toBe("Platform");
		});

		it("answers 400 for an empty body, an unknown key and a non-digit Space id", async () => {
			const t = await createTeam();
			expect(
				(await patch(t.admin.id, t.workspace.id, t.space.id, {})).status,
			).toBe(400);
			expect(
				(
					await patch(t.admin.id, t.workspace.id, t.space.id, {
						workspaceId: "9",
					})
				).status,
			).toBe(400);
			expect(
				(await patch(t.admin.id, t.workspace.id, "abc", { name: "X" })).status,
			).toBe(400);
			expect(
				(
					await patch(t.admin.id, t.workspace.id, t.space.id, {
						kpiTemplate: Array(21).fill({ name: "a", unit: "" }),
					})
				).status,
			).toBe(400);
		});

		describe("Head appointment", () => {
			it("appoints a Head and replaces the old one, with role.change rows (AC14)", async () => {
				const t = await createTeam();
				const res = await patch(t.admin.id, t.workspace.id, t.space.id, {
					headMembershipId: String(t.staffM.id),
				});
				expect(res.status).toBe(200);
				expect(res.data.headMembershipId).toBe(String(t.staffM.id));
				const rows = await getDb().select().from(memberships);
				const role = (id: number) => rows.find((m) => m.id === id)?.role;
				expect(role(t.staffM.id)).toBe("head");
				expect(role(t.headM.id)).toBe("staff");
				const list = await actions();
				expect(list.filter((a) => a === "role.change")).toHaveLength(2);
				expect(list).toContain("space.updated");
			});

			it("clears the Head and turns them into Staff", async () => {
				const t = await createTeam();
				const res = await patch(t.admin.id, t.workspace.id, t.space.id, {
					headMembershipId: null,
				});
				expect(res.status).toBe(200);
				expect(res.data.headMembershipId).toBeNull();
				const [m] = await getDb()
					.select()
					.from(memberships)
					.where(eq(memberships.id, t.headM.id));
				expect(m?.role).toBe("staff");
			});

			it("is a no-op for the current Head", async () => {
				const t = await createTeam();
				const res = await patch(t.admin.id, t.workspace.id, t.space.id, {
					headMembershipId: String(t.headM.id),
				});
				expect(res.status).toBe(200);
				expect(res.data.headMembershipId).toBe(String(t.headM.id));
				expect(await actions()).not.toContain("role.change");
			});

			it("answers 400 for a member outside the Space, an Admin, a deactivated member and a foreign id", async () => {
				const t = await createTeam();
				const finance = await createSpace(t.workspace.id, "Finance");
				const outsiderUser = await createUser();
				const outsider = await addMember(
					t.workspace.id,
					outsiderUser.id,
					"staff",
					finance.id,
				);
				const goneUser = await createUser();
				const gone = await addMember(
					t.workspace.id,
					goneUser.id,
					"staff",
					t.space.id,
					false,
				);
				const otherTeam = await createTeam();
				for (const id of [
					outsider.id,
					t.adminM.id,
					gone.id,
					otherTeam.staffM.id,
					999999,
				]) {
					const res = await patch(t.admin.id, t.workspace.id, t.space.id, {
						headMembershipId: String(id),
					});
					expect(res.status, String(id)).toBe(400);
				}
				const [row] = await getDb()
					.select()
					.from(spaces)
					.where(eq(spaces.id, t.space.id));
				expect(row?.headMembershipId).toBe(t.headM.id);
			});
		});
	});

	it("keeps a Workspace of its own Spaces separate", async () => {
		const owner = await createUser();
		const ws = await createWorkspace(owner.id);
		await addMember(ws.id, owner.id, "admin");
		await createSpace(ws.id, "Ops");
		const t = await createTeam();
		const res = await call(app, "GET", base(ws.id), await as(owner.id));
		expect(res.data.map((s: any) => s.name)).toEqual(["Ops"]);
		void t;
	});
});
