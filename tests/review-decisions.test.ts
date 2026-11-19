/**
 * POST /reports/:id/decision over HTTP on the real test Postgres (AC1 to AC5, AC24).
 * Time is fixed with fake Date.
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
	createSpace,
	createTeam,
	createUser,
} from "./helpers/factories";
import {
	freshWorld,
	NOW,
	q,
	type ReviewEnv,
	requester,
	startApp,
	submitReport,
} from "./helpers/review-env";

describe("review decisions", () => {
	let app: Hono;
	let env: Omit<ReviewEnv, "app">;
	let req: ReturnType<typeof requester>;
	const decide = (
		userId: number,
		id: string,
		decision: string,
		reason?: string,
	) =>
		req(userId, "POST", `/reports/${id}/decision`, {
			decision,
			...(reason !== undefined && { reason }),
		});
	const staffReport = () =>
		submitReport(req, env.team.staffUser.id, env.periodId);
	const row = async (id: string) =>
		(
			await q(
				`select review_status, first_seen_at, window_started_at from reports where id = ${id}`,
			)
		)[0] as Record<string, any>;
	const comments = (id: string) =>
		q(
			`select kind, body from report_comments where report_id = ${id} order by id`,
		);

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

	describe("who may decide (AC1, AC2)", () => {
		it("lets the Head of the Space approve a Staff report, which sets seen and writes an event", async () => {
			const id = await staffReport();
			const res = await decide(env.team.headUser.id, id, "approve");
			expect(res.status).toBe(200);
			expect(res.data.id).toBe(id);
			expect(res.data.reviewStatus).toBe("approved");
			expect(res.data.firstSeenAt).toBe(NOW);
			expect(res.data.windowStartedAt).toBe(NOW);
			expect(res.data.comments).toEqual([]);
			const kinds = res.data.events.map((e: any) => e.kind);
			expect(kinds).toEqual(["submitted", "seen", "approved"]);
			const approved = res.data.events.find((e: any) => e.kind === "approved");
			expect(approved.actorMembershipId).toBe(String(env.team.headM.id));
			expect((await row(id)).review_status).toBe("approved");
		});

		it("lets an Admin approve a Staff report of a headed Space without starting the author's lock", async () => {
			const id = await staffReport();
			const res = await decide(env.team.admin.id, id, "approve");
			expect(res.status).toBe(200);
			expect(res.data.reviewStatus).toBe("approved");
			expect(res.data.firstSeenAt).toBe(NOW);
			expect(res.data.windowStartedAt).toBeNull();
		});

		it("lets an Admin override a Head's reject, and decide a Head's own report", async () => {
			const id = await staffReport();
			expect(
				(await decide(env.team.headUser.id, id, "reject", "Add figures"))
					.status,
			).toBe(200);
			const overridden = await decide(env.team.admin.id, id, "approve");
			expect(overridden.status).toBe(200);
			expect(overridden.data.reviewStatus).toBe("approved");

			const headReport = await submitReport(
				req,
				env.team.headUser.id,
				env.periodId,
			);
			const ok = await decide(env.team.admin.id, headReport, "approve");
			expect(ok.status).toBe(200);
		});

		it("gives the author 403 NOT_AUTHOR_CANNOT_DECIDE: a Head on their own report, and an Admin on their own", async () => {
			const headReport = await submitReport(
				req,
				env.team.headUser.id,
				env.periodId,
			);
			const res = await decide(env.team.headUser.id, headReport, "approve");
			expect(res.status).toBe(403);
			expect(res.error.code).toBe("NOT_AUTHOR_CANNOT_DECIDE");

			const id = await staffReport();
			await q(
				`update memberships set role = 'admin', space_id = null where id = ${env.team.staffM.id}`,
			);
			const own = await decide(env.team.staffUser.id, id, "approve");
			expect(own.status).toBe(403);
			expect(own.error.code).toBe("NOT_AUTHOR_CANNOT_DECIDE");
			expect((await row(id)).review_status).toBe("pending");
		});

		it("gives a Head 404 on a Head-role author's report even in the Head's own Space (V1)", async () => {
			const author = await createUser();
			await addMember(env.ws, author.id, "head", env.team.space.id);
			await q(
				`update spaces set head_membership_id = ${env.team.headM.id} where id = ${env.team.space.id}`,
			);
			const id = await submitReport(req, author.id, env.periodId);
			expect((await decide(env.team.headUser.id, id, "approve")).status).toBe(
				404,
			);
			expect((await decide(env.team.admin.id, id, "approve")).status).toBe(200);
		});

		it("gives Staff, another Space's Head, another Workspace's Admin and a stranger 404", async () => {
			const id = await staffReport();
			const otherSpace = await createSpace(env.ws, "Field");
			const otherHead = await createUser();
			await addMember(env.ws, otherHead.id, "head", otherSpace.id);
			const other = await createTeam();
			const stranger = await createUser();
			for (const userId of [
				env.staff2.userId,
				otherHead.id,
				other.admin.id,
				stranger.id,
			]) {
				const res = await decide(userId, id, "approve");
				expect(res.status, String(userId)).toBe(404);
				expect(res.error).toEqual({ message: "Not found." });
			}
			expect((await row(id)).review_status).toBe("pending");
		});

		it("gives a draft 404 to a reviewer and 409 NOT_SUBMITTED to its author", async () => {
			const draft = await req(
				env.team.staffUser.id,
				"PATCH",
				"/reports/draft",
				{
					periodId: String(env.periodId),
					accomplishments: "<p>x</p>",
				},
			);
			expect(
				(await decide(env.team.admin.id, draft.data.id, "approve")).status,
			).toBe(404);
			const own = await decide(env.team.staffUser.id, draft.data.id, "approve");
			expect(own.status).toBe(409);
			expect(own.error.code).toBe("NOT_SUBMITTED");
		});

		it("gives a deactivated Head 404, a suspended one 401, and a deleted report 404", async () => {
			const id = await staffReport();
			await q(
				`update memberships set active = false where id = ${env.team.headM.id}`,
			);
			expect((await decide(env.team.headUser.id, id, "approve")).status).toBe(
				404,
			);
			await q(
				`update memberships set active = true where id = ${env.team.headM.id}`,
			);
			await q(
				`update users set suspended_at = now() where id = ${env.team.headUser.id}`,
			);
			expect((await decide(env.team.headUser.id, id, "approve")).status).toBe(
				401,
			);
			await q(
				`update users set suspended_at = null where id = ${env.team.headUser.id}`,
			);
			await q(`update reports set deleted_at = now() where id = ${id}`);
			expect((await decide(env.team.admin.id, id, "approve")).status).toBe(404);
		});

		it("blocks a decision in a read-only Workspace", async () => {
			const id = await staffReport();
			await q(`update workspaces set read_only = true where id = ${env.ws}`);
			const res = await decide(env.team.admin.id, id, "approve");
			expect(res.status).toBe(403);
			expect(res.error.code).toBe("WORKSPACE_READ_ONLY");
		});
	});

	describe("reasons (AC4, AC24)", () => {
		it("requires a reason to reject: missing, spaces only, tags only", async () => {
			const id = await staffReport();
			for (const reason of [
				undefined,
				"",
				"   ",
				"<b></b>",
				"<script>alert(1)</script>",
			]) {
				const res = await decide(env.team.headUser.id, id, "reject", reason);
				expect(res.status, String(reason)).toBe(400);
				expect(res.error.reason).toBe(
					"Write a reason of up to 1000 characters.",
				);
			}
			expect((await row(id)).review_status).toBe("pending");
			expect(await comments(id)).toEqual([]);
		});

		it("stores the reason as a decision comment, as plain text", async () => {
			const id = await staffReport();
			const res = await decide(
				env.team.headUser.id,
				id,
				"reject",
				"<p>Add the <b>Q&A</b> numbers</p><script>alert(1)</script>",
			);
			expect(res.status).toBe(200);
			expect(res.data.reviewStatus).toBe("rejected");
			expect(await comments(id)).toEqual([
				{ kind: "decision", body: "Add the Q&A numbers" },
			]);
			expect(res.data.comments).toEqual([
				{
					id: expect.stringMatching(/^[1-9][0-9]*$/),
					reportId: id,
					authorMembershipId: String(env.team.headM.id),
					body: "Add the Q&A numbers",
					at: NOW,
					kind: "decision",
					taskId: null,
				},
			]);
		});

		it("accepts 1000 characters and refuses 1001, counted after sanitizing, and a raw body over 4000", async () => {
			const id = await staffReport();
			const tooLong = await decide(
				env.team.headUser.id,
				id,
				"reject",
				"x".repeat(1001),
			);
			expect(tooLong.status).toBe(400);
			expect(tooLong.error.reason).toBeDefined();
			const rawTooLong = await decide(
				env.team.headUser.id,
				id,
				"reject",
				"x".repeat(4001),
			);
			expect(rawTooLong.status).toBe(400);
			const tagged = await decide(
				env.team.headUser.id,
				id,
				"reject",
				`<b>${"x".repeat(1000)}</b>`,
			);
			expect(tagged.status).toBe(200);
		});

		it("approves without a reason, ignores a reason that is empty after sanitizing, and stores a real one", async () => {
			const a = await staffReport();
			expect((await decide(env.team.headUser.id, a, "approve")).status).toBe(
				200,
			);
			expect(await comments(a)).toEqual([]);

			await q(`update reports set review_status = 'pending' where id = ${a}`);
			const blank = await decide(
				env.team.headUser.id,
				a,
				"approve",
				" <i></i> ",
			);
			expect(blank.status).toBe(200);
			expect(await comments(a)).toEqual([]);

			const b = await submitReport(req, env.staff2.userId, env.periodId);
			expect(
				(await decide(env.team.headUser.id, b, "approve", "Good work")).status,
			).toBe(200);
			expect(await comments(b)).toEqual([
				{ kind: "decision", body: "Good work" },
			]);
			const tooLong = await submitReport(
				req,
				env.team.headUser.id,
				env.periodId,
			);
			const res = await decide(
				env.team.admin.id,
				tooLong,
				"approve",
				"x".repeat(1001),
			);
			expect(res.status).toBe(400);
			expect(res.error.reason).toBeDefined();
		});

		it("refuses a bad decision and an unknown key with a field error", async () => {
			const id = await staffReport();
			const bad = await decide(env.team.headUser.id, id, "maybe");
			expect(bad.status).toBe(400);
			expect(bad.error.decision).toBe("Choose approve, reject or reopen.");
			const extra = await req(
				env.team.headUser.id,
				"POST",
				`/reports/${id}/decision`,
				{
					decision: "approve",
					status: "approved",
				},
			);
			expect(extra.status).toBe(400);
			expect(extra.error.status).toBe("This field is not accepted.");
		});
	});

	describe("approved locks until reopened (AC3, AC5)", () => {
		it("lets an Admin approve after a Head rejected, and keeps the Head's reason in the thread", async () => {
			const id = await staffReport();
			await decide(env.team.headUser.id, id, "reject", "Add figures");
			const res = await decide(env.team.admin.id, id, "approve");
			expect(res.data.reviewStatus).toBe("approved");
			expect((await comments(id)).length).toBe(1);
		});

		it("refuses approve, reject and edit on an approved report, and reopens it to pending with a fresh window", async () => {
			const id = await staffReport();
			await decide(env.team.headUser.id, id, "approve");

			for (const decision of ["approve", "reject"]) {
				const res = await decide(env.team.headUser.id, id, decision, "why");
				expect(res.status, decision).toBe(409);
				expect(res.error.code).toBe("REPORT_APPROVED");
			}
			const edit = await req(env.team.staffUser.id, "PATCH", `/reports/${id}`, {
				plans: "<p>x</p>",
			});
			expect(edit.status).toBe(403);
			expect(edit.error.code).toBe("REPORT_APPROVED");

			const noReason = await decide(env.team.headUser.id, id, "reopen");
			expect(noReason.status).toBe(400);
			const reopened = await decide(
				env.team.admin.id,
				id,
				"reopen",
				"New numbers came in",
			);
			expect(reopened.status).toBe(200);
			expect(reopened.data.reviewStatus).toBe("pending");
			expect(reopened.data.windowStartedAt).toBeNull();
			expect(reopened.data.firstSeenAt).toBe(NOW);
			expect(reopened.data.events.map((e: any) => e.kind)).toEqual([
				"submitted",
				"seen",
				"approved",
				"reopened",
			]);
			expect((await comments(id)).at(-1)).toEqual({
				kind: "decision",
				body: "New numbers came in",
			});
			const again = await req(
				env.team.staffUser.id,
				"PATCH",
				`/reports/${id}`,
				{
					plans: "<p>x</p>",
				},
			);
			expect(again.status).toBe(200);
		});

		it("gives reopen on a report that is not approved 409 NOT_APPROVED", async () => {
			const id = await staffReport();
			const res = await decide(env.team.headUser.id, id, "reopen", "because");
			expect(res.status).toBe(409);
			expect(res.error.code).toBe("NOT_APPROVED");
			await decide(env.team.headUser.id, id, "reject", "no");
			const again = await decide(env.team.headUser.id, id, "reopen", "because");
			expect(again.error.code).toBe("NOT_APPROVED");
		});

		it("serializes two simultaneous decisions: one wins, the other gets 409", async () => {
			const id = await staffReport();
			const [a, b] = await Promise.all([
				decide(env.team.headUser.id, id, "approve"),
				decide(env.team.admin.id, id, "approve"),
			]);
			expect([a.status, b.status].sort()).toEqual([200, 409]);
			const events = await q(
				`select kind from report_events where report_id = ${id} and kind = 'approved'`,
			);
			expect(events.length).toBe(1);
		});
	});

	it("records an audit row with ids only", async () => {
		const id = await staffReport();
		await decide(env.team.headUser.id, id, "reject", "private words here");
		const rows = await q(
			`select action, target, summary from audit_logs where action = 'report.decided'`,
		);
		expect(rows).toEqual([
			{
				action: "report.decided",
				target: `report:${id}`,
				summary: `Report ${id} rejected`,
			},
		]);
		await decide(env.team.headUser.id, id, "approve");
		await decide(env.team.headUser.id, id, "reopen", "reopening");
		const reopened = await q(
			`select summary from audit_logs where action = 'report.reopened'`,
		);
		expect(reopened).toEqual([{ summary: `Report ${id} reopened` }]);
	});
});
