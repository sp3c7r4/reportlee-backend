/**
 * POST /reports/:id/comments over HTTP on the real test Postgres (AC9, AC10, AC21 to AC23, AC25).
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
import { plainText } from "@/modules/report-comment/comment-sanitizer";
import { addMember, createTeam, createUser } from "./helpers/factories";
import { captureLogs } from "./helpers/log-capture";
import {
	freshWorld,
	NOW,
	q,
	type ReviewEnv,
	requester,
	startApp,
	submitReport,
} from "./helpers/review-env";

describe("plainText (D13, AC21)", () => {
	it("strips tags and script content, decodes entities once and trims", () => {
		expect(plainText("Q&A <3")).toBe("Q&A <3");
		expect(plainText("a &lt;script&gt; b")).toBe("a <script> b");
		expect(plainText("&amp;lt;")).toBe("&lt;");
		expect(plainText("<script>alert(1)</script>Please")).toBe("Please");
		expect(plainText('<img src=x onerror="alert(1)">hi')).toBe("hi");
		expect(plainText("  <b></b>  ")).toBe("");
		expect(plainText("<p>Add the <b>figures</b></p>")).toBe("Add the figures");
	});
});

describe("report comments", () => {
	let app: Hono;
	let env: Omit<ReviewEnv, "app">;
	let req: ReturnType<typeof requester>;
	const post = (userId: number, id: string, body: unknown) =>
		req(userId, "POST", `/reports/${id}/comments`, body);
	const followUp = (over: Record<string, unknown> = {}) => ({
		title: "Add the figures",
		assigneeMembershipId: String(env.team.staffM.id),
		dueAt: "2026-11-04",
		priority: "high",
		...over,
	});
	const counts = async (id: string) =>
		(
			await q(
				`select (select count(*) from report_comments where report_id = ${id})::int as c, (select count(*) from tasks where report_id = ${id})::int as t`,
			)
		)[0] as { c: number; t: number };

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

	describe("thread rules (AC9, AC23)", () => {
		it("lets the reviewer start, then the author reply, and returns the documented shape", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			const first = await post(env.team.headUser.id, id, {
				body: "Please add the figures.",
			});
			expect(first.status).toBe(201);
			expect(first.data).toEqual({
				id: expect.stringMatching(/^[1-9][0-9]*$/),
				reportId: id,
				authorMembershipId: String(env.team.headM.id),
				body: "Please add the figures.",
				at: NOW,
				kind: "comment",
				taskId: null,
			});
			const reply = await post(env.team.staffUser.id, id, { body: "Done." });
			expect(reply.status).toBe(201);
			const report = await req(env.team.staffUser.id, "GET", `/reports/${id}`);
			expect(report.data.comments.map((c: any) => c.body)).toEqual([
				"Please add the figures.",
				"Done.",
			]);
		});

		it("refuses the author starting a thread with REVIEWER_MUST_START", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			const res = await post(env.team.staffUser.id, id, { body: "Hello?" });
			expect(res.status).toBe(403);
			expect(res.error.code).toBe("REVIEWER_MUST_START");
			expect((await counts(id)).c).toBe(0);
		});

		it("lets the author answer a rejection reason (a decision comment counts)", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			await req(env.team.headUser.id, "POST", `/reports/${id}/decision`, {
				decision: "reject",
				reason: "Add numbers",
			});
			const res = await post(env.team.staffUser.id, id, { body: "Added." });
			expect(res.status).toBe(201);
		});

		it("gives a colleague, another Space's Head, another Workspace and a stranger 404", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			const other = await createTeam();
			for (const userId of [
				env.staff2.userId,
				other.admin.id,
				other.headUser.id,
				(await createUser()).id,
			]) {
				const res = await post(userId, id, { body: "hi" });
				expect(res.status, String(userId)).toBe(404);
			}
			expect((await counts(id)).c).toBe(0);
		});

		it("gives a non-designated Admin 403 NOT_REVIEWER, and lets the Admin start when the Space has no Head", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			const res = await post(env.team.admin.id, id, { body: "hi" });
			expect(res.status).toBe(403);
			expect(res.error.code).toBe("NOT_REVIEWER");
			await q(
				`update spaces set head_membership_id = null where id = ${env.team.space.id}`,
			);
			expect((await post(env.team.admin.id, id, { body: "hi" })).status).toBe(
				201,
			);
		});

		it("gives a draft 404 and blocks commenting in a read-only Workspace", async () => {
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
				(await post(env.team.headUser.id, draft.data.id, { body: "x" })).status,
			).toBe(404);
			const id = await submitReport(req, env.staff2.userId, env.periodId);
			await q(`update workspaces set read_only = true where id = ${env.ws}`);
			const res = await post(env.team.headUser.id, id, { body: "x" });
			expect(res.status).toBe(403);
			expect(res.error.code).toBe("WORKSPACE_READ_ONLY");
		});

		it("accepts comments and a follow-up on an approved report (design review, finding 3)", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			await req(env.team.headUser.id, "POST", `/reports/${id}/decision`, {
				decision: "approve",
			});
			const res = await post(env.team.headUser.id, id, {
				body: "One more thing",
				followUp: followUp(),
			});
			expect(res.status).toBe(201);
			expect(res.data.taskId).toMatch(/^[1-9][0-9]*$/);
		});
	});

	describe("sanitizing and limits (AC9, AC21)", () => {
		it("stores plain text: tags and scripts stripped, entities decoded", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			const res = await post(env.team.headUser.id, id, {
				body: "<script>alert(1)</script><p>Q&amp;A &lt;3 <b>now</b></p>",
			});
			expect(res.status).toBe(201);
			expect(res.data.body).toBe("Q&A <3 now");
			const [row] = await q(
				`select body from report_comments where report_id = ${id}`,
			);
			expect(row?.body).toBe("Q&A <3 now");
		});

		it("refuses an empty, tag-only or over-long body with a field error, counted after sanitizing", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			for (const body of ["", "   ", "<b></b>", "x".repeat(2001)]) {
				const res = await post(env.team.headUser.id, id, { body });
				expect(res.status).toBe(400);
				expect(res.error.body).toBe(
					"Write a comment of up to 2000 characters.",
				);
			}
			expect(
				(
					await post(env.team.headUser.id, id, {
						body: `<i>${"x".repeat(2000)}</i>`,
					})
				).status,
			).toBe(201);
			expect(
				(await post(env.team.headUser.id, id, { body: "x".repeat(6001) }))
					.status,
			).toBe(400);
			const extra = await post(env.team.headUser.id, id, {
				body: "x",
				kind: "decision",
			});
			expect(extra.status).toBe(400);
			expect(extra.error.kind).toBe("This field is not accepted.");
		});
	});

	describe("follow-up tasks (AC10, AC22)", () => {
		it("creates the task in the same transaction and links it from the comment", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			const res = await post(env.team.headUser.id, id, {
				body: "Please add the figures.",
				followUp: followUp({ title: "<b>Add</b> the figures" }),
			});
			expect(res.status).toBe(201);
			const [task] = await q(
				`select id, comment_id, title, assignee_membership_id, assigned_by_membership_id, due_on::text as due, status, priority from tasks where report_id = ${id}`,
			);
			expect(task).toEqual({
				id: Number(res.data.taskId),
				comment_id: Number(res.data.id),
				title: "Add the figures",
				assignee_membership_id: env.team.staffM.id,
				assigned_by_membership_id: env.team.headM.id,
				due: "2026-11-04",
				status: "todo",
				priority: "high",
			});
			const audit = await q(
				`select summary from audit_logs where action = 'task.created'`,
			);
			expect(audit.length).toBe(1);
		});

		it("refuses a bad assignee or date with a field error and saves neither comment nor task", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			const other = await createTeam();
			const gone = await createUser();
			const goneM = await addMember(
				env.ws,
				gone.id,
				"staff",
				env.team.space.id,
				false,
			);
			for (const assignee of [
				String(env.team.adminM.id),
				String(env.team.headM.id),
				String(other.staffM.id),
				String(goneM.id),
			]) {
				const res = await post(env.team.headUser.id, id, {
					body: "x",
					followUp: followUp({ assigneeMembershipId: assignee }),
				});
				expect(res.status, assignee).toBe(400);
				expect(res.error["followUp.assigneeMembershipId"]).toBe(
					"Choose an active Staff member or Head of this Workspace.",
				);
			}
			for (const dueAt of ["2026-02-30", "04/11/2026", "2026-11-4"]) {
				const res = await post(env.team.headUser.id, id, {
					body: "x",
					followUp: followUp({ dueAt }),
				});
				expect(res.status, dueAt).toBe(400);
				expect(res.error["followUp.dueAt"]).toBe("Use the form YYYY-MM-DD.");
			}
			const badPriority = await post(env.team.headUser.id, id, {
				body: "x",
				followUp: followUp({ priority: "urgent" }),
			});
			expect(badPriority.status).toBe(400);
			const emptyTitle = await post(env.team.headUser.id, id, {
				body: "x",
				followUp: followUp({ title: "<b></b>" }),
			});
			expect(emptyTitle.status).toBe(400);
			expect(emptyTitle.error["followUp.title"]).toBeDefined();
			expect(await counts(id)).toEqual({ c: 0, t: 0 });
		});

		it("accepts a past due date (D26)", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			const res = await post(env.team.headUser.id, id, {
				body: "x",
				followUp: followUp({ dueAt: "2020-01-01" }),
			});
			expect(res.status).toBe(201);
		});

		it("refuses a follow-up from the author with REVIEWER_MUST_START", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			await post(env.team.headUser.id, id, { body: "Start" });
			const res = await post(env.team.staffUser.id, id, {
				body: "reply",
				followUp: followUp({
					assigneeMembershipId: String(env.staff2.membershipId),
				}),
			});
			expect(res.status).toBe(403);
			expect(res.error.code).toBe("REVIEWER_MUST_START");
		});

		it("makes a reviewer comment a look: firstSeenAt set, so the author cannot delete", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			await post(env.team.headUser.id, id, { body: "Looked" });
			const [row] = await q(
				`select first_seen_at, window_started_at from reports where id = ${id}`,
			);
			expect(row?.first_seen_at).not.toBeNull();
			expect(row?.window_started_at).not.toBeNull();
			const del = await req(env.team.staffUser.id, "DELETE", `/reports/${id}`);
			expect(del.status).toBe(403);
			expect(del.error.code).toBe("REPORT_SEEN");
		});
	});

	it("keeps comment bodies out of stdout (AC25)", async () => {
		const id = await submitReport(req, env.team.staffUser.id, env.periodId);
		const logs = captureLogs();
		try {
			await post(env.team.headUser.id, id, {
				body: "zebra-secret-phrase-123",
				followUp: followUp({ title: "giraffe-title-456" }),
			});
			await req(env.team.staffUser.id, "GET", `/reports/${id}`);
		} finally {
			logs.stop();
		}
		const text = logs.text();
		expect(text).not.toContain("zebra-secret-phrase-123");
		expect(text).not.toContain("giraffe-title-456");
	});
});
