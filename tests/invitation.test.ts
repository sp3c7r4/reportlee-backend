import "./helpers/app";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/postgres.db";
import {
	audit_logs,
	invitations,
	memberships,
	spaces,
	users,
	workspaces,
} from "@/db/postgres.schema";
import {
	buildApp,
	call,
	emailJobs,
	queueBehaviour,
	resetQueue,
} from "./helpers/app";
import { sessionFor } from "./helpers/auth";
import { resetTestDb, setupTestDb } from "./helpers/db";
import {
	addMember,
	createSpace,
	createTeam,
	createUser,
} from "./helpers/factories";
import { captureLogs } from "./helpers/log-capture";

type Team = Awaited<ReturnType<typeof createTeam>>;

describe("invitations", () => {
	let app: Hono;

	beforeAll(async () => {
		await setupTestDb();
		app = await buildApp();
	});
	beforeEach(async () => {
		await resetTestDb();
		resetQueue();
	});
	afterEach(() => resetQueue());

	const as = async (userId: number, opts = {}) => ({
		headers: await sessionFor(userId, opts),
	});
	const inv = (wsId: number) => `/workspaces/${wsId}/invitations`;
	const send = async (
		userId: number,
		wsId: number,
		rows: unknown[],
		opts = {},
	) =>
		call(app, "POST", inv(wsId), {
			...(await as(userId, opts)),
			body: { invitations: rows },
		});
	const tokenOf = (url: string) => url.split("/invite/")[1] as string;
	const newcomer = (email: string, extra = {}) =>
		createUser({ email, ...extra });
	const staffRow = (t: Team, email: string) => ({
		email,
		role: "staff",
		spaceId: String(t.space.id),
	});
	const hash = (token: string) =>
		createHash("sha256").update(token).digest("hex");
	const expire = async (id: number) =>
		getDb()
			.update(invitations)
			.set({ expiresAt: sql`now() - interval '1 minute'` })
			.where(eq(invitations.id, id));
	const preview = async (userId: number, token: string, opts = {}) =>
		call(app, "POST", "/invitations/preview", {
			...(await as(userId, opts)),
			body: { token },
		});
	const accept = async (userId: number, token: string, opts = {}) =>
		call(app, "POST", "/invitations/accept", {
			...(await as(userId, opts)),
			body: { token },
		});
	const actions = async () =>
		(await getDb().select().from(audit_logs)).map((a) => a.action);

	describe("POST create: who may invite what (AC4)", () => {
		it("lets an Admin invite staff, head and admin and returns one-time links", async () => {
			const t = await createTeam();
			await getDb()
				.update(spaces)
				.set({ headMembershipId: null })
				.where(eq(spaces.id, t.space.id));
			await getDb()
				.update(memberships)
				.set({ role: "staff" })
				.where(eq(memberships.id, t.headM.id));
			const res = await send(t.admin.id, t.workspace.id, [
				{
					email: "  New.Staff@Example.com ",
					role: "staff",
					spaceId: String(t.space.id),
				},
				{
					email: "new.head@example.com",
					role: "head",
					spaceId: String(t.space.id),
				},
				{ email: "new.admin@example.com", role: "admin" },
			]);
			expect(res.status).toBe(201);
			expect(res.data).toHaveLength(3);
			expect(res.data[0]).toMatchObject({
				email: "new.staff@example.com",
				role: "staff",
				space: "Platform",
				spaceId: String(t.space.id),
				invitedByMembershipId: String(t.adminM.id),
				expired: false,
			});
			expect(res.data[2]).toMatchObject({
				role: "admin",
				space: null,
				spaceId: null,
			});
			for (const row of res.data) {
				expect(row.inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
			}
			expect(await actions()).toEqual([
				"invitation.sent",
				"invitation.sent",
				"invitation.sent",
			]);
		});

		it("lets a Head invite Staff into their own Space, and fills in the Space", async () => {
			const t = await createTeam();
			const res = await send(t.headUser.id, t.workspace.id, [
				{ email: "a@example.com", role: "staff" },
				{ email: "b@example.com", role: "staff", spaceId: String(t.space.id) },
			]);
			expect(res.status).toBe(201);
			expect(res.data.map((r: any) => r.spaceId)).toEqual([
				String(t.space.id),
				String(t.space.id),
			]);
		});

		it("answers 403 for a Head inviting an Admin or a Head, or into another Space", async () => {
			const t = await createTeam();
			const finance = await createSpace(t.workspace.id, "Finance");
			for (const row of [
				{ email: "a@example.com", role: "admin" },
				{ email: "b@example.com", role: "head", spaceId: String(t.space.id) },
				{ email: "c@example.com", role: "staff", spaceId: String(finance.id) },
			]) {
				const res = await send(t.headUser.id, t.workspace.id, [row]);
				expect(res.status, JSON.stringify(row)).toBe(403);
			}
			expect(await getDb().select().from(invitations)).toHaveLength(0);
		});

		it("answers 403 for Staff", async () => {
			const t = await createTeam();
			const res = await send(t.staffUser.id, t.workspace.id, [
				staffRow(t, "a@example.com"),
			]);
			expect(res.status).toBe(403);
		});

		it("answers 404 for a non-member and 401 without a token", async () => {
			const t = await createTeam();
			const other = await createTeam();
			expect(
				(
					await send(other.admin.id, t.workspace.id, [
						staffRow(t, "a@example.com"),
					])
				).status,
			).toBe(404);
			const anon = await call(app, "POST", inv(t.workspace.id), {
				body: { invitations: [] },
			});
			expect(anon.status).toBe(401);
		});
	});

	describe("POST create: bad bodies", () => {
		it("answers 400 for each invalid batch", async () => {
			const t = await createTeam();
			const ok = staffRow(t, "ok@example.com");
			const sixRows = Array.from({ length: 6 }, (_, i) =>
				staffRow(t, `p${i}@example.com`),
			);
			const cases: Array<[string, unknown[]]> = [
				["empty batch", []],
				["six rows", sixRows],
				["duplicate email", [ok, { ...ok, email: "OK@example.com" }]],
				["invalid email", [{ ...ok, email: "not-an-email" }]],
				["head without a Space", [{ email: "h@example.com", role: "head" }]],
				["staff without a Space", [{ email: "s@example.com", role: "staff" }]],
				[
					"admin with a Space",
					[
						{
							email: "a@example.com",
							role: "admin",
							spaceId: String(t.space.id),
						},
					],
				],
				["unknown key", [{ ...ok, extra: 1 }]],
				[
					"over-length email",
					[{ ...ok, email: `${"a".repeat(250)}@example.com` }],
				],
				["bad role", [{ ...ok, role: "owner" }]],
				["bad Space id", [{ ...ok, spaceId: "0" }]],
			];
			for (const [name, rows] of cases) {
				const res = await send(t.admin.id, t.workspace.id, rows);
				expect(res.status, name).toBe(400);
			}
			expect(await getDb().select().from(invitations)).toHaveLength(0);
		});

		it("answers 400 for a Space of another Workspace and for an archived Space", async () => {
			const t = await createTeam();
			const other = await createTeam();
			const archived = await createSpace(t.workspace.id, "Old", {
				archivedAt: new Date(),
			});
			for (const spaceId of [other.space.id, archived.id]) {
				const res = await send(t.admin.id, t.workspace.id, [
					{ email: "a@example.com", role: "staff", spaceId: String(spaceId) },
				]);
				expect(res.status).toBe(400);
			}
		});

		it("answers 400 (not 422) for a non-object body", async () => {
			const t = await createTeam();
			const res = await call(app, "POST", inv(t.workspace.id), {
				...(await as(t.admin.id)),
				body: [],
			});
			expect(res.status).toBe(400);
		});
	});

	describe("POST create: duplicates and Head slots", () => {
		it("answers 409 for an active member and for a pending invitation", async () => {
			const t = await createTeam();
			const member = await send(t.admin.id, t.workspace.id, [
				staffRow(t, t.staffUser.email.toUpperCase()),
			]);
			expect(member.status).toBe(409);
			expect(member.error.message).toBe(
				"That person is already in this Workspace or has a pending invitation.",
			);
			expect(
				(
					await send(t.admin.id, t.workspace.id, [
						staffRow(t, "dup@example.com"),
					])
				).status,
			).toBe(201);
			const pending = await send(t.admin.id, t.workspace.id, [
				staffRow(t, "dup@example.com"),
			]);
			expect(pending.status).toBe(409);
		});

		it("gives a deactivated member their own message", async () => {
			const t = await createTeam();
			const gone = await createUser();
			await addMember(t.workspace.id, gone.id, "staff", t.space.id, false);
			const res = await send(t.admin.id, t.workspace.id, [
				staffRow(t, gone.email),
			]);
			expect(res.status).toBe(409);
			expect(res.error.message).toBe(
				"That person already has an account here. Reactivate them from People.",
			);
		});

		it("answers 409 for a Head invitation when the Space has a Head or one is pending", async () => {
			const t = await createTeam();
			const taken = await send(t.admin.id, t.workspace.id, [
				{ email: "h@example.com", role: "head", spaceId: String(t.space.id) },
			]);
			expect(taken.status).toBe(409);
			const free = await createSpace(t.workspace.id, "Finance");
			const row = { role: "head", spaceId: String(free.id) };
			expect(
				(
					await send(t.admin.id, t.workspace.id, [
						{ ...row, email: "h1@example.com" },
					])
				).status,
			).toBe(201);
			expect(
				(
					await send(t.admin.id, t.workspace.id, [
						{ ...row, email: "h2@example.com" },
					])
				).status,
			).toBe(409);
		});
	});

	describe("seats (AC6)", () => {
		const limit = async (t: Team, n: number) =>
			getDb()
				.update(workspaces)
				.set({ memberLimit: n })
				.where(eq(workspaces.id, t.workspace.id));

		it("counts pending invitations toward the limit, and a batch over the limit creates none", async () => {
			const t = await createTeam();
			await limit(t, 5);
			const over = await send(t.admin.id, t.workspace.id, [
				staffRow(t, "a@example.com"),
				staffRow(t, "b@example.com"),
				staffRow(t, "c@example.com"),
			]);
			expect(over.status).toBe(422);
			expect(over.error.message).toBe(
				"This Workspace is at its member limit (3 of 5 seats used).",
			);
			expect(await getDb().select().from(invitations)).toHaveLength(0);
			expect(
				(
					await send(t.admin.id, t.workspace.id, [
						staffRow(t, "a@example.com"),
						staffRow(t, "b@example.com"),
					])
				).status,
			).toBe(201);
			expect(
				(await send(t.admin.id, t.workspace.id, [staffRow(t, "c@example.com")]))
					.status,
			).toBe(422);
		});

		it("frees the seat when an invitation is revoked", async () => {
			const t = await createTeam();
			await limit(t, 4);
			const first = await send(t.admin.id, t.workspace.id, [
				staffRow(t, "a@example.com"),
			]);
			expect(
				(await send(t.admin.id, t.workspace.id, [staffRow(t, "b@example.com")]))
					.status,
			).toBe(422);
			const revoke = await call(
				app,
				"DELETE",
				`${inv(t.workspace.id)}/${first.data[0].id}`,
				await as(t.admin.id),
			);
			expect(revoke.status).toBe(200);
			expect(
				(await send(t.admin.id, t.workspace.id, [staffRow(t, "b@example.com")]))
					.status,
			).toBe(201);
		});

		it("does not count an expired invitation as a seat", async () => {
			const t = await createTeam();
			await limit(t, 4);
			const first = await send(t.admin.id, t.workspace.id, [
				staffRow(t, "a@example.com"),
			]);
			await expire(Number(first.data[0].id));
			expect(
				(await send(t.admin.id, t.workspace.id, [staffRow(t, "b@example.com")]))
					.status,
			).toBe(201);
		});

		it("leaves at most the limit when two creates race for the last seat", async () => {
			const t = await createTeam();
			await limit(t, 4);
			const headers = await as(t.admin.id);
			const go = (email: string) =>
				call(app, "POST", inv(t.workspace.id), {
					...headers,
					body: { invitations: [staffRow(t, email)] },
				});
			const [a, b] = await Promise.all([
				go("r1@example.com"),
				go("r2@example.com"),
			]);
			expect([a.status, b.status].sort()).toEqual([201, 422]);
			expect(await getDb().select().from(invitations)).toHaveLength(1);
		});
	});

	describe("secrets and the email job (AC11)", () => {
		it("stores only a sha256 hash and keeps links out of the list response", async () => {
			const t = await createTeam();
			const res = await send(t.admin.id, t.workspace.id, [
				staffRow(t, "a@example.com"),
			]);
			const token = tokenOf(res.data[0].inviteUrl);
			const [row] = await getDb().select().from(invitations);
			expect(row?.tokenHash).toBe(hash(token));
			expect(JSON.stringify(row)).not.toContain(token);
			const list = await call(
				app,
				"GET",
				inv(t.workspace.id),
				await as(t.admin.id),
			);
			expect(list.status).toBe(200);
			expect(JSON.stringify(list.json)).not.toContain(token);
			expect(JSON.stringify(list.json)).not.toContain("inviteUrl");
			expect(list.data[0]).not.toHaveProperty("inviteUrl");
		});

		it("queues one email per invitation with the documented options", async () => {
			const t = await createTeam();
			const res = await send(t.admin.id, t.workspace.id, [
				staffRow(t, "a@example.com"),
			]);
			expect(emailJobs).toHaveLength(1);
			const job = emailJobs[0];
			expect(job?.name).toBe("invitation");
			expect(job?.data.template).toBe("invitation");
			expect(job?.data.message.to).toBe("a@example.com");
			expect(job?.data.message.subject).toBe(
				`You are invited to join ${t.workspace.name} on Reportlee`,
			);
			expect(job?.data.idempotencyKey).toBe(`invitation:${res.data[0].id}`);
			expect(job?.data.locals).toMatchObject({
				workspaceName: t.workspace.name,
				role: "staff",
				expiresInDays: 7,
				inviteUrl: res.data[0].inviteUrl,
			});
			expect(job?.opts).toEqual({
				removeOnComplete: true,
				removeOnFail: { age: 86400 },
			});
		});

		it("still answers 201 when the queue fails", async () => {
			const t = await createTeam();
			queueBehaviour.fail = true;
			const res = await send(t.admin.id, t.workspace.id, [
				staffRow(t, "a@example.com"),
			]);
			expect(res.status).toBe(201);
			expect(await getDb().select().from(invitations)).toHaveLength(1);
		});

		it("writes no email, raw token or link to the logs while rostering, inviting and accepting", async () => {
			const t = await createTeam();
			const invited = await newcomer("quiet.person@example.com");
			const log = captureLogs();
			let text = "";
			let token = "";
			let url = "";
			try {
				await call(
					app,
					"GET",
					`/workspaces/${t.workspace.id}/members`,
					await as(t.admin.id),
				);
				const created = await send(t.admin.id, t.workspace.id, [
					staffRow(t, "quiet.person@example.com"),
				]);
				url = created.data[0].inviteUrl;
				token = tokenOf(url);
				await call(app, "GET", inv(t.workspace.id), await as(t.admin.id));
				await preview(invited.id, token);
				await accept(invited.id, token);
				await call(app, "GET", "/me/memberships", await as(invited.id));
			} finally {
				text = log.text();
				log.stop();
			}
			/* @info - Positive control: the capture does see console and stdout writes. */
			const control = captureLogs();
			console.log("control-console");
			process.stdout.write("control-stdout\n");
			const seen = control.text();
			control.stop();
			expect(seen).toContain("control-console");
			expect(seen).toContain("control-stdout");
			for (const secret of [
				"quiet.person@example.com",
				t.staffUser.email,
				t.admin.email,
				token,
				url,
			]) {
				expect(text, secret).not.toContain(secret);
			}
		});
	});

	describe("GET list and DELETE revoke", () => {
		it("lets an Admin see all pending rows and a Head only their Space's rows", async () => {
			const t = await createTeam();
			const finance = await createSpace(t.workspace.id, "Finance");
			await send(t.admin.id, t.workspace.id, [
				staffRow(t, "own@example.com"),
				{
					email: "other@example.com",
					role: "staff",
					spaceId: String(finance.id),
				},
				{ email: "boss@example.com", role: "admin" },
			]);
			const admin = await call(
				app,
				"GET",
				inv(t.workspace.id),
				await as(t.admin.id),
			);
			expect(admin.data).toHaveLength(3);
			const head = await call(
				app,
				"GET",
				inv(t.workspace.id),
				await as(t.headUser.id),
			);
			expect(head.data.map((r: any) => r.email)).toEqual(["own@example.com"]);
		});

		it("answers 403 for Staff and 404 for a non-member", async () => {
			const t = await createTeam();
			const other = await createTeam();
			expect(
				(await call(app, "GET", inv(t.workspace.id), await as(t.staffUser.id)))
					.status,
			).toBe(403);
			expect(
				(await call(app, "GET", inv(t.workspace.id), await as(other.admin.id)))
					.status,
			).toBe(404);
		});

		it("marks an unswept expired row as expired in the list", async () => {
			const t = await createTeam();
			const res = await send(t.admin.id, t.workspace.id, [
				staffRow(t, "a@example.com"),
			]);
			await expire(Number(res.data[0].id));
			const list = await call(
				app,
				"GET",
				inv(t.workspace.id),
				await as(t.admin.id),
			);
			expect(list.data[0].expired).toBe(true);
		});

		it("revokes as Admin, as the inviter, and refuses a Head on someone else's row", async () => {
			const t = await createTeam();
			const byAdmin = await send(t.admin.id, t.workspace.id, [
				staffRow(t, "a@example.com"),
			]);
			const byHead = await send(t.headUser.id, t.workspace.id, [
				{ email: "b@example.com", role: "staff" },
			]);
			const del = async (user: number, id: string) =>
				call(app, "DELETE", `${inv(t.workspace.id)}/${id}`, await as(user));
			expect((await del(t.headUser.id, byAdmin.data[0].id)).status).toBe(403);
			const own = await del(t.headUser.id, byHead.data[0].id);
			expect(own.status).toBe(200);
			expect(own.data).toEqual({ id: byHead.data[0].id, status: "revoked" });
			expect((await del(t.admin.id, byAdmin.data[0].id)).status).toBe(200);
			expect(await actions()).toContain("invitation.revoked");
			const token = tokenOf(byAdmin.data[0].inviteUrl);
			const invited = await newcomer("a@example.com");
			expect((await accept(invited.id, token)).status).toBe(404);
		});

		it("answers 403 for Staff, 404 for a foreign Workspace's invitation and 400 for a bad id", async () => {
			const t = await createTeam();
			const other = await createTeam();
			const made = await send(other.admin.id, other.workspace.id, [
				staffRow(other, "a@example.com"),
			]);
			const id = made.data[0].id;
			expect(
				(
					await call(
						app,
						"DELETE",
						`${inv(t.workspace.id)}/${id}`,
						await as(t.admin.id),
					)
				).status,
			).toBe(404);
			expect(
				(
					await call(
						app,
						"DELETE",
						`${inv(t.workspace.id)}/${id}`,
						await as(t.staffUser.id),
					)
				).status,
			).toBe(403);
			expect(
				(
					await call(
						app,
						"DELETE",
						`${inv(t.workspace.id)}/abc`,
						await as(t.admin.id),
					)
				).status,
			).toBe(400);
			const [row] = await getDb()
				.select()
				.from(invitations)
				.where(eq(invitations.id, Number(id)));
			expect(row?.status).toBe("pending");
		});

		it("revokes an unswept expired row (200) but not a swept one (404) (AC20)", async () => {
			const t = await createTeam();
			const res = await send(t.admin.id, t.workspace.id, [
				staffRow(t, "a@example.com"),
				staffRow(t, "b@example.com"),
			]);
			const [a, b] = res.data;
			await expire(Number(a.id));
			await expire(Number(b.id));
			expect(
				(
					await call(
						app,
						"DELETE",
						`${inv(t.workspace.id)}/${a.id}`,
						await as(t.admin.id),
					)
				).status,
			).toBe(200);
			/* @info - Any create sweeps expired rows to `expired`. */
			await send(t.admin.id, t.workspace.id, [staffRow(t, "c@example.com")]);
			expect(
				(
					await call(
						app,
						"DELETE",
						`${inv(t.workspace.id)}/${b.id}`,
						await as(t.admin.id),
					)
				).status,
			).toBe(404);
		});
	});

	describe("preview and accept (AC7)", () => {
		const invite = async (t: Team, email: string, role = "staff") => {
			const res = await send(t.admin.id, t.workspace.id, [
				role === "admin"
					? { email, role }
					: { email, role, spaceId: String(t.space.id) },
			]);
			expect(res.status).toBe(201);
			return {
				token: tokenOf(res.data[0].inviteUrl),
				id: Number(res.data[0].id),
			};
		};

		it("previews with a masked email and accepts into the Workspace", async () => {
			const t = await createTeam();
			const person = await newcomer("nia.okoye@example.com");
			const { token } = await invite(t, "nia.okoye@example.com");
			const view = await preview(person.id, token);
			expect(view.status).toBe(200);
			expect(view.data).toEqual({
				workspaceName: t.workspace.name,
				role: "staff",
				spaceName: "Platform",
				email: "n***@example.com",
			});
			const res = await accept(person.id, token);
			expect(res.status).toBe(200);
			expect(res.data.membership).toMatchObject({
				userId: String(person.id),
				role: "staff",
				space: "Platform",
				spaceId: String(t.space.id),
			});
			expect(res.data.workspace).toMatchObject({
				id: String(t.workspace.id),
				memberCount: 4,
			});
			const [user] = await getDb()
				.select()
				.from(users)
				.where(eq(users.id, person.id));
			expect(user?.lastWorkspaceId).toBe(t.workspace.id);
			expect(await actions()).toContain("member.joined");
			const roster = await call(
				app,
				"GET",
				`/workspaces/${t.workspace.id}/members`,
				await as(t.admin.id),
			);
			expect(roster.data).toHaveLength(4);
		});

		it("accepts an Admin invitation without a Space", async () => {
			const t = await createTeam();
			const person = await newcomer("boss@example.com");
			const { token } = await invite(t, "boss@example.com", "admin");
			const res = await accept(person.id, token);
			expect(res.data.membership).toMatchObject({
				role: "admin",
				space: null,
				spaceId: null,
			});
		});

		it("accepts a Head invitation and fills the Head slot", async () => {
			const t = await createTeam();
			await getDb()
				.update(spaces)
				.set({ headMembershipId: null })
				.where(eq(spaces.id, t.space.id));
			await getDb()
				.update(memberships)
				.set({ role: "staff" })
				.where(eq(memberships.id, t.headM.id));
			const person = await newcomer("lead@example.com");
			const { token } = await invite(t, "lead@example.com", "head");
			const res = await accept(person.id, token);
			expect(res.status).toBe(200);
			const [space] = await getDb()
				.select()
				.from(spaces)
				.where(eq(spaces.id, t.space.id));
			expect(space?.headMembershipId).toBe(Number(res.data.membership.id));
		});

		it("answers the same 404 for an unknown, revoked, used and expired token", async () => {
			const t = await createTeam();
			const person = await newcomer("p@example.com");
			const used = await invite(t, "p@example.com");
			await accept(person.id, used.token);
			const other = await newcomer("q@example.com");
			const second = await invite(t, "q@example.com");
			await expire(second.id);
			const third = await newcomer("r@example.com");
			const revoked = await invite(t, "r@example.com");
			await call(
				app,
				"DELETE",
				`${inv(t.workspace.id)}/${revoked.id}`,
				await as(t.admin.id),
			);
			const bodies: unknown[] = [];
			for (const [user, token] of [
				[other.id, "x".repeat(43)],
				[third.id, revoked.token],
				[other.id, second.token],
			] as const) {
				for (const run of [preview, accept]) {
					const res = await run(user, token);
					expect(res.status).toBe(404);
					bodies.push(res.error);
				}
			}
			expect((await preview(person.id, used.token)).status).toBe(404);
			expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
			expect(bodies[0]).toEqual({
				message: "This invitation is not valid. Ask for a new one.",
			});
		});

		it("answers 403 INVITE_EMAIL_MISMATCH for another address and creates no Membership", async () => {
			const t = await createTeam();
			const wrong = await newcomer("someone.else@example.com");
			const { token } = await invite(t, "intended@example.com");
			for (const run of [preview, accept]) {
				const res = await run(wrong.id, token);
				expect(res.status).toBe(403);
				expect(res.error).toEqual({
					message:
						"This invitation was sent to i***@example.com. Sign in with that address.",
					code: "INVITE_EMAIL_MISMATCH",
				});
			}
			expect(await getDb().select().from(memberships)).toHaveLength(3);
		});

		it("reads the verified state from the user row, not the cache (AC18)", async () => {
			const t = await createTeam();
			const person = await newcomer("p@example.com", { emailVerified: false });
			const { token } = await invite(t, "p@example.com");
			for (const run of [preview, accept]) {
				const res = await run(person.id, token, { emailVerified: true });
				expect(res.status).toBe(403);
				expect(res.error).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
			}
		});

		it("answers 401 for a deleted user and 400 for a bad token", async () => {
			const t = await createTeam();
			const gone = await newcomer("g@example.com", { deletedAt: new Date() });
			const { token } = await invite(t, "g@example.com");
			expect((await accept(gone.id, token)).status).toBe(401);
			const person = await newcomer("p@example.com");
			for (const bad of ["short", "x".repeat(101)]) {
				expect((await accept(person.id, bad)).status).toBe(400);
			}
			const res = await call(app, "POST", "/invitations/accept", {
				...(await as(person.id)),
				body: { token, extra: 1 },
			});
			expect(res.status).toBe(400);
		});

		it("lets the same person accept twice with one Membership, and two simultaneous accepts make one", async () => {
			const t = await createTeam();
			const person = await newcomer("p@example.com");
			const { token } = await invite(t, "p@example.com");
			const [a, b] = await Promise.all([
				accept(person.id, token),
				accept(person.id, token),
			]);
			/* @info - The loser either sees the winner's accepted row (the same person, so the idempotent 200)
			 * or loses the conditional update (404). Never a second Membership. */
			expect([a.status, b.status]).toContain(200);
			for (const r of [a, b]) expect([200, 404, 409]).toContain(r.status);
			const again = await accept(person.id, token);
			expect(again.status).toBe(200);
			const mine = (await getDb().select().from(memberships)).filter(
				(m) => m.userId === person.id,
			);
			expect(mine).toHaveLength(1);
		});

		it("refuses a second person using a used token", async () => {
			const t = await createTeam();
			const person = await newcomer("p@example.com");
			const { token } = await invite(t, "p@example.com");
			await accept(person.id, token);
			const other = await newcomer("o@example.com");
			expect((await accept(other.id, token)).status).toBe(404);
		});

		it("answers 409 for an active member and keeps the invitation pending", async () => {
			const t = await createTeam();
			const { token, id } = await invite(
				t,
				t.staffUser.email.replace("@", "+x@"),
			);
			await getDb()
				.update(users)
				.set({ email: t.staffUser.email.replace("@", "+x@") })
				.where(eq(users.id, t.staffUser.id));
			const res = await accept(t.staffUser.id, token);
			expect(res.status).toBe(409);
			expect(res.error.message).toBe("You already belong to this Workspace.");
			const [row] = await getDb()
				.select()
				.from(invitations)
				.where(eq(invitations.id, id));
			expect(row?.status).toBe("pending");
		});

		it("answers 409 for a deactivated Membership with the turned-off message", async () => {
			const t = await createTeam();
			const person = await newcomer("p@example.com");
			const { token, id } = await invite(t, "p@example.com");
			await addMember(t.workspace.id, person.id, "staff", t.space.id, false);
			const res = await accept(person.id, token);
			expect(res.status).toBe(409);
			expect(res.error.message).toBe(
				"Your access was turned off. Ask an Admin to reactivate you.",
			);
			const [row] = await getDb()
				.select()
				.from(invitations)
				.where(eq(invitations.id, id));
			expect(row?.status).toBe("pending");
		});

		it("does not return 200 on re-accept when the Membership was deactivated afterwards", async () => {
			const t = await createTeam();
			const person = await newcomer("p@example.com");
			const { token } = await invite(t, "p@example.com");
			const ok = await accept(person.id, token);
			await getDb()
				.update(memberships)
				.set({ active: false })
				.where(eq(memberships.id, Number(ok.data.membership.id)));
			const again = await accept(person.id, token);
			expect(again.status).toBe(409);
			expect(again.error.message).toBe(
				"Your access was turned off. Ask an Admin to reactivate you.",
			);
		});

		it("answers 409 when the Space was archived, and when a Head slot was taken meanwhile", async () => {
			const t = await createTeam();
			const person = await newcomer("p@example.com");
			const { token } = await invite(t, "p@example.com");
			await getDb()
				.update(spaces)
				.set({ archivedAt: new Date() })
				.where(eq(spaces.id, t.space.id));
			const archived = await accept(person.id, token);
			expect(archived.status).toBe(409);
			expect(archived.error.message).toBe(
				"This Space is archived. Ask for a new invitation.",
			);

			const free = await createSpace(t.workspace.id, "Finance");
			const lead = await newcomer("lead@example.com");
			const made = await send(t.admin.id, t.workspace.id, [
				{ email: "lead@example.com", role: "head", spaceId: String(free.id) },
			]);
			const leadToken = tokenOf(made.data[0].inviteUrl);
			const sitting = await createUser();
			const sittingM = await addMember(
				t.workspace.id,
				sitting.id,
				"head",
				free.id,
			);
			void sittingM;
			const taken = await accept(lead.id, leadToken);
			expect(taken.status).toBe(409);
			const [row] = await getDb()
				.select()
				.from(invitations)
				.where(eq(invitations.id, Number(made.data[0].id)));
			expect(row?.status).toBe("pending");
		});

		it("lets an invitation hold its seat: accepting needs no extra seat (D21)", async () => {
			const t = await createTeam();
			await getDb()
				.update(workspaces)
				.set({ memberLimit: 4 })
				.where(eq(workspaces.id, t.workspace.id));
			const person = await newcomer("p@example.com");
			const { token } = await invite(t, "p@example.com");
			expect((await accept(person.id, token)).status).toBe(200);
		});
	});
});
