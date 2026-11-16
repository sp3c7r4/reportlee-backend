import "./helpers/app";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/postgres.db";
import {
	audit_logs,
	memberships,
	spaces,
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
} from "./helpers/factories";

describe("members", () => {
	let app: Hono;

	beforeAll(async () => {
		await setupTestDb();
		app = await buildApp();
	});
	beforeEach(async () => {
		await resetTestDb();
	});

	const as = async (userId: number) => ({ headers: await sessionFor(userId) });
	const roster = async (userId: number, wsId: number) =>
		call(app, "GET", `/workspaces/${wsId}/members`, await as(userId));
	const patch = async (
		userId: number,
		wsId: number,
		id: number | string,
		body: unknown,
	) =>
		call(app, "PATCH", `/workspaces/${wsId}/members/${id}`, {
			...(await as(userId)),
			body,
		});
	const actions = async () =>
		(await getDb().select().from(audit_logs)).map((a) => a.action);
	const rowOf = async (id: number) =>
		(await getDb().select().from(memberships).where(eq(memberships.id, id)))[0];

	describe("GET roster", () => {
		it("shows an Admin everyone with emails, including deactivated people", async () => {
			const t = await createTeam();
			const goneUser = await createUser();
			await addMember(t.workspace.id, goneUser.id, "staff", t.space.id, false);
			const res = await roster(t.admin.id, t.workspace.id);
			expect(res.status).toBe(200);
			expect(res.data).toHaveLength(4);
			const staff = res.data.find(
				(m: any) => m.membershipId === String(t.staffM.id),
			);
			expect(staff).toMatchObject({
				role: "staff",
				space: "Platform",
				spaceId: String(t.space.id),
				active: true,
				email: t.staffUser.email,
			});
			expect(typeof staff.joinedAt).toBe("string");
			expect(res.data.filter((m: any) => !m.active)).toHaveLength(1);
		});

		it("shows Staff and Head only active people, with no email field (P9)", async () => {
			const t = await createTeam();
			const goneUser = await createUser();
			await addMember(t.workspace.id, goneUser.id, "staff", t.space.id, false);
			for (const user of [t.staffUser, t.headUser]) {
				const res = await roster(user.id, t.workspace.id);
				expect(res.status).toBe(200);
				expect(res.data).toHaveLength(3);
				for (const m of res.data) {
					expect(m).not.toHaveProperty("email");
					expect(m.active).toBe(true);
				}
				expect(JSON.stringify(res.json)).not.toContain("@example.com");
			}
		});

		it("answers 404 for another Workspace and 401 without a token", async () => {
			const t = await createTeam();
			const other = await createTeam();
			expect((await roster(t.admin.id, other.workspace.id)).status).toBe(404);
			expect(
				(await call(app, "GET", `/workspaces/${t.workspace.id}/members`))
					.status,
			).toBe(401);
		});

		it("does not count a deleted or suspended person as active (AC19)", async () => {
			const t = await createTeam();
			await getDb()
				.update(users)
				.set({ deletedAt: new Date() })
				.where(eq(users.id, t.staffUser.id));
			const asAdmin = await roster(t.admin.id, t.workspace.id);
			expect(
				asAdmin.data.find((m: any) => m.membershipId === String(t.staffM.id))
					.active,
			).toBe(false);
			const asHead = await roster(t.headUser.id, t.workspace.id);
			expect(asHead.data).toHaveLength(2);
		});
	});

	describe("PATCH member", () => {
		it("answers 403 for Staff and for a Head", async () => {
			const t = await createTeam();
			for (const user of [t.staffUser, t.headUser]) {
				const res = await patch(user.id, t.workspace.id, t.staffM.id, {
					active: false,
				});
				expect(res.status).toBe(403);
			}
			expect((await rowOf(t.staffM.id))?.active).toBe(true);
		});

		it("answers 404 for a Membership of another Workspace (AC3)", async () => {
			const t = await createTeam();
			const other = await createTeam();
			const res = await patch(t.admin.id, t.workspace.id, other.staffM.id, {
				active: false,
			});
			expect(res.status).toBe(404);
			expect((await rowOf(other.staffM.id))?.active).toBe(true);
			expect(
				(await patch(t.admin.id, t.workspace.id, 999999, { active: false }))
					.status,
			).toBe(404);
		});

		it("answers 400 for an empty body, an unknown key, a bad role and a non-digit id", async () => {
			const t = await createTeam();
			for (const body of [
				{},
				{ name: "x" },
				{ role: "owner" },
				{ active: "yes" },
			]) {
				expect(
					(await patch(t.admin.id, t.workspace.id, t.staffM.id, body)).status,
					JSON.stringify(body),
				).toBe(400);
			}
			expect(
				(await patch(t.admin.id, t.workspace.id, "abc", { active: false }))
					.status,
			).toBe(400);
		});

		it("promotes Staff to Admin and drops the Space", async () => {
			const t = await createTeam();
			const res = await patch(t.admin.id, t.workspace.id, t.staffM.id, {
				role: "admin",
			});
			expect(res.status).toBe(200);
			expect(res.data).toMatchObject({
				role: "admin",
				space: null,
				spaceId: null,
				email: t.staffUser.email,
			});
			expect(await actions()).toContain("role.change");
		});

		it("answers 400 for an Admin with a Space, and for Admin to Staff with no Space", async () => {
			const t = await createTeam();
			const withSpace = await patch(t.admin.id, t.workspace.id, t.staffM.id, {
				role: "admin",
				spaceId: String(t.space.id),
			});
			expect(withSpace.status).toBe(400);
			const second = await createUser();
			const secondM = await addMember(t.workspace.id, second.id, "admin");
			const noSpace = await patch(t.admin.id, t.workspace.id, secondM.id, {
				role: "staff",
			});
			expect(noSpace.status).toBe(400);
			expect((await rowOf(secondM.id))?.role).toBe("admin");
		});

		it("answers 400 for a Space of another Workspace and for an archived Space", async () => {
			const t = await createTeam();
			const other = await createTeam();
			const foreign = await patch(t.admin.id, t.workspace.id, t.staffM.id, {
				spaceId: String(other.space.id),
			});
			expect(foreign.status).toBe(400);
			const archived = await createSpace(t.workspace.id, "Old", {
				archivedAt: new Date(),
			});
			const res = await patch(t.admin.id, t.workspace.id, t.staffM.id, {
				spaceId: String(archived.id),
			});
			expect(res.status).toBe(400);
			expect((await rowOf(t.staffM.id))?.spaceId).toBe(t.space.id);
		});

		it("moves Staff to another Space", async () => {
			const t = await createTeam();
			const finance = await createSpace(t.workspace.id, "Finance");
			const res = await patch(t.admin.id, t.workspace.id, t.staffM.id, {
				spaceId: String(finance.id),
			});
			expect(res.status).toBe(200);
			expect(res.data).toMatchObject({
				space: "Finance",
				spaceId: String(finance.id),
			});
		});

		describe("last Admin (AC5)", () => {
			it("answers 409 when demoting or deactivating the last Admin", async () => {
				const t = await createTeam();
				const demote = await patch(t.admin.id, t.workspace.id, t.adminM.id, {
					role: "staff",
					spaceId: String(t.space.id),
				});
				expect(demote.status).toBe(409);
				expect(demote.error.message).toBe(
					"A Workspace needs at least one active Admin.",
				);
				const off = await patch(t.admin.id, t.workspace.id, t.adminM.id, {
					active: false,
				});
				expect(off.status).toBe(409);
				const row = await rowOf(t.adminM.id);
				expect(row).toMatchObject({ role: "admin", active: true });
			});

			it("lets an Admin step down when another active Admin exists", async () => {
				const t = await createTeam();
				const second = await createUser();
				await addMember(t.workspace.id, second.id, "admin");
				const res = await patch(second.id, t.workspace.id, t.adminM.id, {
					active: false,
				});
				expect(res.status).toBe(200);
				expect(res.data.active).toBe(false);
				expect(await actions()).toContain("member.deactivated");
			});

			it("leaves exactly one Admin when two Admins demote each other at once", async () => {
				const t = await createTeam();
				const second = await createUser();
				const secondM = await addMember(t.workspace.id, second.id, "admin");
				/* @info - One caller sends both requests, so both pass the guard before either commits. */
				const [a, b] = await Promise.all([
					patch(t.admin.id, t.workspace.id, secondM.id, { active: false }),
					patch(t.admin.id, t.workspace.id, t.adminM.id, { active: false }),
				]);
				/* @info - The loser is refused either by the last-Admin rule (409) or, when the winner
				 * committed before its guard ran, because it is no longer a member (404). */
				const [winner, loser] = [a.status, b.status].sort();
				expect(winner).toBe(200);
				expect([404, 409]).toContain(loser);
				const admins = (await getDb().select().from(memberships)).filter(
					(m) => m.role === "admin" && m.active,
				);
				expect(admins).toHaveLength(1);
			});

			it("does not count an Admin whose user was deleted (AC19)", async () => {
				const t = await createTeam();
				const ghost = await createUser();
				await addMember(t.workspace.id, ghost.id, "admin");
				await getDb()
					.update(users)
					.set({ deletedAt: new Date() })
					.where(eq(users.id, ghost.id));
				const res = await patch(t.admin.id, t.workspace.id, t.adminM.id, {
					active: false,
				});
				expect(res.status).toBe(409);
			});
		});

		describe("Head rules", () => {
			it("promotes Staff to Head when the slot is empty, and GET spaces shows it", async () => {
				const t = await createTeam();
				await getDb()
					.update(spaces)
					.set({ headMembershipId: null })
					.where(eq(spaces.id, t.space.id));
				await getDb()
					.update(memberships)
					.set({ role: "staff" })
					.where(eq(memberships.id, t.headM.id));
				const res = await patch(t.admin.id, t.workspace.id, t.staffM.id, {
					role: "head",
				});
				expect(res.status).toBe(200);
				expect(res.data.role).toBe("head");
				const list = await call(
					app,
					"GET",
					`/workspaces/${t.workspace.id}/spaces`,
					await as(t.admin.id),
				);
				expect(list.data[0].headMembershipId).toBe(String(t.staffM.id));
			});

			it("answers 409 when the Space already has a Head", async () => {
				const t = await createTeam();
				const res = await patch(t.admin.id, t.workspace.id, t.staffM.id, {
					role: "head",
				});
				expect(res.status).toBe(409);
				expect((await rowOf(t.staffM.id))?.role).toBe("staff");
			});

			it("frees the slot when a Head is deactivated or demoted", async () => {
				const t = await createTeam();
				const off = await patch(t.admin.id, t.workspace.id, t.headM.id, {
					active: false,
				});
				expect(off.status).toBe(200);
				const [space] = await getDb()
					.select()
					.from(spaces)
					.where(eq(spaces.id, t.space.id));
				expect(space?.headMembershipId).toBeNull();
				const promote = await patch(t.admin.id, t.workspace.id, t.staffM.id, {
					role: "head",
				});
				expect(promote.status).toBe(200);
				const demote = await patch(t.admin.id, t.workspace.id, t.staffM.id, {
					role: "staff",
				});
				expect(demote.status).toBe(200);
				const [after] = await getDb()
					.select()
					.from(spaces)
					.where(eq(spaces.id, t.space.id));
				expect(after?.headMembershipId).toBeNull();
			});

			it("answers 409 when a Head tries to change Space", async () => {
				const t = await createTeam();
				const finance = await createSpace(t.workspace.id, "Finance");
				const res = await patch(t.admin.id, t.workspace.id, t.headM.id, {
					spaceId: String(finance.id),
				});
				expect(res.status).toBe(409);
				expect((await rowOf(t.headM.id))?.spaceId).toBe(t.space.id);
			});

			it("answers 400 for a deactivated person made Head in the same call", async () => {
				const t = await createTeam();
				await getDb()
					.update(spaces)
					.set({ headMembershipId: null })
					.where(eq(spaces.id, t.space.id));
				await getDb()
					.update(memberships)
					.set({ role: "staff" })
					.where(eq(memberships.id, t.headM.id));
				const res = await patch(t.admin.id, t.workspace.id, t.staffM.id, {
					role: "head",
					active: false,
				});
				expect(res.status).toBe(400);
			});
		});

		describe("seats (reactivation)", () => {
			it("answers 422 when reactivating over the limit, 200 with room", async () => {
				const t = await createTeam();
				const goneUser = await createUser();
				const gone = await addMember(
					t.workspace.id,
					goneUser.id,
					"staff",
					t.space.id,
					false,
				);
				await getDb()
					.update(workspaces)
					.set({ memberLimit: 4 })
					.where(eq(workspaces.id, t.workspace.id));
				const full = await createUser();
				await addMember(t.workspace.id, full.id, "staff", t.space.id);
				const blocked = await patch(t.admin.id, t.workspace.id, gone.id, {
					active: true,
				});
				expect(blocked.status).toBe(422);
				expect(blocked.error.message).toBe(
					"This Workspace is at its member limit (4 of 4 seats used).",
				);
				await getDb()
					.update(workspaces)
					.set({ memberLimit: 5 })
					.where(eq(workspaces.id, t.workspace.id));
				const ok = await patch(t.admin.id, t.workspace.id, gone.id, {
					active: true,
				});
				expect(ok.status).toBe(200);
				expect(await actions()).toContain("member.reactivated");
			});

			it("does not count a deleted user as a seat (AC19)", async () => {
				const t = await createTeam();
				const goneUser = await createUser();
				const gone = await addMember(
					t.workspace.id,
					goneUser.id,
					"staff",
					t.space.id,
					false,
				);
				const ghost = await createUser();
				await addMember(t.workspace.id, ghost.id, "staff", t.space.id);
				await getDb()
					.update(users)
					.set({ deletedAt: new Date() })
					.where(eq(users.id, ghost.id));
				await getDb()
					.update(workspaces)
					.set({ memberLimit: 4 })
					.where(eq(workspaces.id, t.workspace.id));
				const ok = await patch(t.admin.id, t.workspace.id, gone.id, {
					active: true,
				});
				expect(ok.status).toBe(200);
			});
		});

		it("writes audit rows that hold no email", async () => {
			const t = await createTeam();
			await patch(t.admin.id, t.workspace.id, t.staffM.id, { active: false });
			await patch(t.admin.id, t.workspace.id, t.staffM.id, { active: true });
			const audit = await getDb().select().from(audit_logs);
			expect(audit.map((a) => a.action)).toEqual([
				"member.deactivated",
				"member.reactivated",
			]);
			for (const row of audit) {
				expect(`${row.target} ${row.summary}`).not.toContain("@");
			}
		});
	});
});
