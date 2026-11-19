/**
 * GET /review/queue and POST /review/bulk-approve over HTTP on the real test Postgres (AC6, AC15).
 */
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
import {
	addMember,
	createPeriod,
	createSpace,
	createTeam,
	createUser,
} from "./helpers/factories";
import {
	freshWorld,
	q,
	type ReviewEnv,
	requester,
	startApp,
	submitReport,
} from "./helpers/review-env";

describe("review queue and bulk approve", () => {
	let app: Hono;
	let env: Omit<ReviewEnv, "app">;
	let req: ReturnType<typeof requester>;
	const queue = (userId: number, periodId = env.periodId, ws = env.ws) =>
		req(userId, "GET", `/review/queue?workspaceId=${ws}&periodId=${periodId}`);
	const ids = (res: { data: any }) =>
		(res.data.reports as { id: string }[]).map((r) => r.id).sort();
	const bulk = (userId: number, reportIds: string[], ws = env.ws) =>
		req(userId, "POST", "/review/bulk-approve", {
			workspaceId: String(ws),
			reportIds,
		});

	beforeAll(async () => {
		app = await startApp();
		req = requester(app);
	});
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		env = await freshWorld();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe("queue scope per role (AC15)", () => {
		it("gives Staff 403 NOT_REVIEWER", async () => {
			const res = await queue(env.team.staffUser.id);
			expect(res.status).toBe(403);
			expect(res.error.code).toBe("NOT_REVIEWER");
		});

		it("shows a Head the Staff reports of their own Space, not drafts, not Head-authored, not another Space's", async () => {
			const staffId = await submitReport(
				req,
				env.team.staffUser.id,
				env.periodId,
			);
			const staff2Id = await submitReport(req, env.staff2.userId, env.periodId);
			await submitReport(req, env.team.headUser.id, env.periodId);
			await req(env.team.staffUser.id, "PATCH", "/reports/draft", {
				periodId: String(env.periodId),
				accomplishments: "<p>draft</p>",
			});
			const otherSpace = await createSpace(env.ws, "Field");
			const otherHead = await createUser();
			await addMember(env.ws, otherHead.id, "head", otherSpace.id);
			const fieldStaff = await createUser();
			await addMember(env.ws, fieldStaff.id, "staff", otherSpace.id);
			await submitReport(req, fieldStaff.id, env.periodId);

			const res = await queue(env.team.headUser.id);
			expect(res.status).toBe(200);
			expect(ids(res)).toEqual([staffId, staff2Id].sort());
			expect(res.data.reports[0]).toHaveProperty("comments");
			expect(res.data.reports[0]).toHaveProperty("events");
		});

		it("shows an Admin every submitted report of the Workspace, ordered by submission time, and no drafts", async () => {
			const a = await submitReport(req, env.team.staffUser.id, env.periodId);
			vi.setSystemTime(Date.now() + 60_000);
			const b = await submitReport(req, env.team.headUser.id, env.periodId);
			vi.setSystemTime(Date.now() + 60_000);
			await req(env.staff2.userId, "PATCH", "/reports/draft", {
				periodId: String(env.periodId),
				accomplishments: "<p>draft</p>",
			});
			const res = await queue(env.team.admin.id);
			expect(res.status).toBe(200);
			expect(res.data.reports.map((r: any) => r.id)).toEqual([a, b]);
		});

		it("leaves a Head-role author's report out of the Head's queue (V1) and the caller's own report out of theirs", async () => {
			const author = await createUser();
			await addMember(env.ws, author.id, "head", env.team.space.id);
			await q(
				`update spaces set head_membership_id = ${env.team.headM.id} where id = ${env.team.space.id}`,
			);
			const headAuthored = await submitReport(req, author.id, env.periodId);
			const staffId = await submitReport(
				req,
				env.team.staffUser.id,
				env.periodId,
			);
			expect(ids(await queue(env.team.headUser.id))).toEqual([staffId]);
			expect(ids(await queue(env.team.admin.id))).toEqual(
				[headAuthored, staffId].sort(),
			);

			const own = await submitReport(req, env.staff2.userId, env.periodId);
			await q(
				`update memberships set role = 'admin', space_id = null where id = ${env.staff2.membershipId}`,
			);
			const res = await queue(env.staff2.userId);
			expect(ids(res)).not.toContain(own);
			expect(ids(res)).toEqual([headAuthored, staffId].sort());
		});

		it("gives a non-member 404, another Workspace's period 404, and a bad id 400", async () => {
			const other = await createTeam();
			const otherPeriod = await createPeriod(
				other.workspace.id,
				"2026-10-25T23:00:00.000Z",
				"2026-11-01T22:59:59.000Z",
				"2026-11-02T16:00:00.000Z",
			);
			expect((await queue(other.admin.id)).status).toBe(404);
			expect((await queue(env.team.admin.id, otherPeriod.id)).status).toBe(404);
			const bad = await req(
				env.team.admin.id,
				"GET",
				`/review/queue?workspaceId=${env.ws}&periodId=abc`,
			);
			expect(bad.status).toBe(400);
			const missing = await req(
				env.team.admin.id,
				"GET",
				`/review/queue?workspaceId=${env.ws}`,
			);
			expect(missing.status).toBe(400);
		});

		it("does not list a deleted report, and lists a rejected or approved one", async () => {
			const a = await submitReport(req, env.team.staffUser.id, env.periodId);
			const b = await submitReport(req, env.staff2.userId, env.periodId);
			await q(`update reports set deleted_at = now() where id = ${a}`);
			await q(`update reports set review_status = 'approved' where id = ${b}`);
			const res = await queue(env.team.admin.id);
			expect(ids(res)).toEqual([b]);
		});
	});

	describe("missing list (AC15)", () => {
		it("lists active non-Admin members without a submitted report, counts a draft as missing, and leaves out Admins and deactivated members", async () => {
			await submitReport(req, env.team.staffUser.id, env.periodId);
			await req(env.staff2.userId, "PATCH", "/reports/draft", {
				periodId: String(env.periodId),
				accomplishments: "<p>draft</p>",
			});
			const gone = await createUser();
			await addMember(env.ws, gone.id, "staff", env.team.space.id, false);
			const res = await queue(env.team.admin.id);
			const missing = res.data.missing as any[];
			const byId = Object.fromEntries(missing.map((m) => [m.membershipId, m]));
			expect(Object.keys(byId).sort()).toEqual(
				[String(env.team.headM.id), String(env.staff2.membershipId)].sort(),
			);
			expect(byId[String(env.staff2.membershipId)]).toEqual({
				membershipId: String(env.staff2.membershipId),
				name: expect.stringContaining("Person"),
				role: "staff",
				space: "Platform",
				submitted: false,
				hasDraft: true,
			});
			expect(byId[String(env.team.headM.id)].hasDraft).toBe(false);
		});

		it("scopes a Head's missing list to their own Space and leaves the Head out", async () => {
			const otherSpace = await createSpace(env.ws, "Field");
			const fieldStaff = await createUser();
			await addMember(env.ws, fieldStaff.id, "staff", otherSpace.id);
			const res = await queue(env.team.headUser.id);
			expect(
				(res.data.missing as any[]).map((m) => m.membershipId).sort(),
			).toEqual(
				[String(env.team.staffM.id), String(env.staff2.membershipId)].sort(),
			);
		});
	});

	describe("bulk approve (AC6)", () => {
		it("approves what the Admin may and names each skipped report with its code, never aborting", async () => {
			const a = await submitReport(req, env.team.staffUser.id, env.periodId);
			const b = await submitReport(req, env.staff2.userId, env.periodId);
			const headReport = await submitReport(
				req,
				env.team.headUser.id,
				env.periodId,
			);
			const third = await createUser();
			await addMember(env.ws, third.id, "staff", env.team.space.id);
			const alreadyApproved = await submitReport(req, third.id, env.periodId);
			await q(
				`update reports set review_status = 'approved' where id = ${alreadyApproved}`,
			);
			const fourth = await createUser();
			await addMember(env.ws, fourth.id, "staff", env.team.space.id);
			const draft = (
				await req(fourth.id, "PATCH", "/reports/draft", {
					periodId: String(env.periodId),
					accomplishments: "<p>x</p>",
				})
			).data.id as string;
			const other = await createTeam();
			const foreign = await submitReport(
				req,
				other.staffUser.id,
				(
					await createPeriod(
						other.workspace.id,
						"2026-10-25T23:00:00.000Z",
						"2026-11-01T22:59:59.000Z",
						"2026-11-02T16:00:00.000Z",
					)
				).id,
			);

			const res = await bulk(env.team.admin.id, [
				b,
				a,
				headReport,
				alreadyApproved,
				draft,
				foreign,
				a,
				"999999",
			]);
			expect(res.status).toBe(200);
			expect([...res.data.approved].sort()).toEqual([a, b, headReport].sort());
			const skipped = Object.fromEntries(
				(res.data.skipped as { id: string; code: string }[]).map((s) => [
					s.id,
					s.code,
				]),
			);
			expect(skipped).toEqual({
				[alreadyApproved]: "REPORT_APPROVED",
				[draft]: "NOT_FOUND",
				[foreign]: "NOT_FOUND",
				"999999": "NOT_FOUND",
			});
			expect(res.data.approved.length + res.data.skipped.length).toBe(7);
			const states = await q(
				`select id, review_status from reports where id in (${a}, ${b}, ${headReport}, ${foreign})`,
			);
			expect(
				Object.fromEntries(states.map((s) => [String(s.id), s.review_status])),
			).toEqual({
				[a]: "approved",
				[b]: "approved",
				[headReport]: "approved",
				[foreign]: "pending",
			});
		});

		it("skips the Admin's own report with NOT_AUTHOR_CANNOT_DECIDE", async () => {
			const id = await submitReport(req, env.staff2.userId, env.periodId);
			await q(
				`update memberships set role = 'admin', space_id = null where id = ${env.staff2.membershipId}`,
			);
			const res = await bulk(env.staff2.userId, [id]);
			expect(res.status).toBe(200);
			expect(res.data).toEqual({
				approved: [],
				skipped: [{ id, code: "NOT_AUTHOR_CANNOT_DECIDE" }],
			});
		});

		it("gives a Head and Staff 403, a stranger 404, and refuses 0 or 101 ids and an unknown key", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			for (const userId of [env.team.headUser.id, env.team.staffUser.id]) {
				const res = await bulk(userId, [id]);
				expect(res.status).toBe(403);
				expect(res.error.code).toBe("NOT_REVIEWER");
			}
			expect((await bulk((await createUser()).id, [id])).status).toBe(404);
			const none = await bulk(env.team.admin.id, []);
			expect(none.status).toBe(400);
			expect(none.error.reportIds).toBeDefined();
			const many = await bulk(
				env.team.admin.id,
				Array.from({ length: 101 }, (_, i) => String(i + 1)),
			);
			expect(many.status).toBe(400);
			const extra = await req(
				env.team.admin.id,
				"POST",
				"/review/bulk-approve",
				{
					workspaceId: String(env.ws),
					reportIds: [id],
					reason: "x",
				},
			);
			expect(extra.status).toBe(400);
			expect(extra.error.reason).toBe("This field is not accepted.");
		});

		it("skips a report of another Workspace the Admin also belongs to", async () => {
			const other = await createTeam();
			const periodB = await createPeriod(
				other.workspace.id,
				"2026-10-25T23:00:00.000Z",
				"2026-11-01T22:59:59.000Z",
				"2026-11-02T16:00:00.000Z",
			);
			const idB = await submitReport(req, other.staffUser.id, periodB.id);
			await addMember(other.workspace.id, env.team.admin.id, "admin");
			const res = await bulk(env.team.admin.id, [idB]);
			expect(res.data).toEqual({
				approved: [],
				skipped: [{ id: idB, code: "NOT_FOUND" }],
			});
		});
	});
});
