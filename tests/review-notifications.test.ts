/**
 * Review notifications (V7, AC13) and decision emails (V8, AC14) over HTTP on the real test
 * Postgres. The email queue and the realtime push are recorders (tests/helpers/app.ts).
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
import { config } from "@/config";
import { logger } from "@/utils";
import {
	emailJobs,
	published,
	queueBehaviour,
	resetQueue,
} from "./helpers/app";
import { addMember, createPeriod, createTeam } from "./helpers/factories";
import { captureLogs } from "./helpers/log-capture";
import {
	freshWorld,
	q,
	type ReviewEnv,
	requester,
	startApp,
	submitReport,
} from "./helpers/review-env";

const switchable = config as unknown as { decisionEmailsEnabled: boolean };

describe("review notifications and decision emails", () => {
	let app: Hono;
	let env: Omit<ReviewEnv, "app">;
	let req: ReturnType<typeof requester>;
	const rows = (userId: number) =>
		q(
			`select type, title, message, workspace_id, membership_id, href, read_at from notifications where user_id = ${userId} order by id`,
		);
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

	beforeAll(async () => {
		app = await startApp();
		req = requester(app);
	});
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		env = await freshWorld();
		resetQueue();
		switchable.decisionEmailsEnabled = true;
	});
	afterEach(() => {
		vi.useRealTimers();
		switchable.decisionEmailsEnabled = true;
	});

	describe("who is told (V7, AC13)", () => {
		it("tells the Space's Head about a submission, with the workspace and the report link", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			expect(await rows(env.team.headUser.id)).toEqual([
				{
					type: "submission",
					title: "A report is waiting for review",
					message: "A report was submitted for you to review.",
					workspace_id: env.ws,
					membership_id: env.team.headM.id,
					href: `/dashboard/reports/${id}`,
					read_at: null,
				},
			]);
			expect(await rows(env.team.admin.id)).toEqual([]);
			expect(await rows(env.team.staffUser.id)).toEqual([]);
			expect(published.map((p) => p.envelope.data.payload.href)).toEqual([
				`/dashboard/reports/${id}`,
			]);
		});

		it("tells the Admins, not the Space's Head, about a Head's submission", async () => {
			await submitReport(req, env.team.headUser.id, env.periodId);
			expect((await rows(env.team.admin.id)).map((r) => r.type)).toEqual([
				"submission",
			]);
			expect(await rows(env.team.headUser.id)).toEqual([]);
		});

		it("tells the author about a decision, without the reason text (D24)", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			await decide(env.team.headUser.id, id, "reject", "private-reason-words");
			const mine = await rows(env.team.staffUser.id);
			expect(mine.map((r) => [r.type, r.title])).toEqual([
				["decision", "Your report needs changes"],
			]);
			expect(JSON.stringify(mine)).not.toContain("private-reason-words");
			await decide(env.team.admin.id, id, "approve");
			await decide(env.team.admin.id, id, "reopen", "again");
			expect((await rows(env.team.staffUser.id)).map((r) => r.title)).toEqual([
				"Your report needs changes",
				"Your report was approved",
				"Your report was reopened",
			]);
		});

		it("sends a reviewer comment to the author, an author reply to the reviewer, and a task to the assignee", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			await req(env.team.headUser.id, "POST", `/reports/${id}/comments`, {
				body: "Please add figures",
				followUp: {
					title: "Add figures",
					assigneeMembershipId: String(env.team.staffM.id),
					dueAt: "2026-11-04",
					priority: "low",
				},
			});
			expect((await rows(env.team.staffUser.id)).map((r) => r.type)).toEqual([
				"comment",
				"task",
			]);
			await req(env.team.staffUser.id, "POST", `/reports/${id}/comments`, {
				body: "Added",
			});
			expect((await rows(env.team.headUser.id)).map((r) => r.type)).toEqual([
				"submission",
				"comment",
			]);
			expect(await rows(env.team.admin.id)).toEqual([]);
		});

		it("tells nobody about a tag, and skips a deactivated recipient", async () => {
			await req(env.team.staffUser.id, "PATCH", "/reports/draft", {
				periodId: String(env.periodId),
				accomplishments: `<p>${"x".repeat(60)}</p>`,
				taggedMembershipIds: [String(env.staff2.membershipId)],
			});
			await q(
				`update memberships set active = false where id = ${env.team.headM.id}`,
			);
			const draft = await req(
				env.team.staffUser.id,
				"GET",
				`/reports/draft?periodId=${env.periodId}`,
			);
			await req(
				env.team.staffUser.id,
				"POST",
				`/reports/${draft.data.id}/submit`,
			);
			expect(await rows(env.staff2.userId)).toEqual([]);
			expect(await rows(env.team.headUser.id)).toEqual([]);
		});
	});

	describe("inbox per Workspace (AC13)", () => {
		it("filters list, count and read-all by Workspace, and never changes another user's row", async () => {
			/* @info - The Head of Workspace A is also a Head in Workspace B. */
			const other = await createTeam();
			const periodB = await createPeriod(
				other.workspace.id,
				"2026-10-25T23:00:00.000Z",
				"2026-11-01T22:59:59.000Z",
				"2026-11-02T16:00:00.000Z",
			);
			await q(
				`update spaces set head_membership_id = null where id = ${other.space.id}`,
			);
			await q(
				`update memberships set role = 'staff' where id = ${other.headM.id}`,
			);
			await addMember(
				other.workspace.id,
				env.team.headUser.id,
				"head",
				other.space.id,
			);
			await submitReport(req, env.team.staffUser.id, env.periodId);
			await submitReport(req, other.staffUser.id, periodB.id);

			const head = env.team.headUser.id;
			const all = await req(head, "GET", "/notifications");
			expect(all.data.data.length).toBe(2);
			const a = await req(head, "GET", `/notifications?workspaceId=${env.ws}`);
			expect(a.data.data.map((n: any) => n.workspaceId)).toEqual([
				String(env.ws),
			]);
			expect(a.data.data[0]).toEqual({
				id: expect.any(Number),
				type: "submission",
				title: "A report is waiting for review",
				message: "A report was submitted for you to review.",
				metadata: expect.any(Object),
				read: false,
				createdAt: expect.any(String),
				workspaceId: String(env.ws),
				href: expect.stringMatching(/^\/dashboard\/reports\/\d+$/),
			});
			const countA = await req(
				head,
				"GET",
				`/notifications/unread-count?workspaceId=${env.ws}`,
			);
			expect(countA.data).toEqual({ count: 1 });
			expect(
				(await req(head, "GET", "/notifications/unread-count")).data,
			).toEqual({ count: 2 });

			const readA = await req(head, "POST", "/notifications/read-all", {
				workspaceId: String(env.ws),
			});
			expect(readA.status).toBe(200);
			expect(
				(
					await req(
						head,
						"GET",
						`/notifications/unread-count?workspaceId=${env.ws}`,
					)
				).data,
			).toEqual({ count: 0 });
			expect(
				(
					await req(
						head,
						"GET",
						`/notifications/unread-count?workspaceId=${other.workspace.id}`,
					)
				).data,
			).toEqual({ count: 1 });

			const bRow = (await req(head, "GET", "/notifications")).data.data.find(
				(n: any) => n.workspaceId === String(other.workspace.id),
			);
			const stranger = await req(
				env.team.staffUser.id,
				"PATCH",
				`/notifications/${bRow.id}/read`,
			);
			expect(stranger.data).toEqual({ updated: false });
			const mine = await req(head, "PATCH", `/notifications/${bRow.id}/read`);
			expect(mine.data).toEqual({ updated: true });
			expect(
				(await req(head, "GET", "/notifications/unread-count")).data,
			).toEqual({ count: 0 });
		});

		it("accepts read-all with no body, refuses bad JSON, an unknown key and a bad id", async () => {
			const head = env.team.headUser.id;
			expect((await req(head, "POST", "/notifications/read-all")).status).toBe(
				200,
			);
			expect(
				(await req(head, "POST", "/notifications/read-all", { scope: "x" }))
					.error,
			).toEqual({ scope: "This field is not accepted." });
			expect(
				(
					await req(head, "POST", "/notifications/read-all", {
						workspaceId: "abc",
					})
				).status,
			).toBe(400);
			expect(
				(await req(head, "GET", "/notifications/unread-count?workspaceId=-1"))
					.status,
			).toBe(400);
		});
	});

	describe("decision emails (V8, AC14)", () => {
		it("queues one email to the author for approve and for reject, with a stable key and no reason", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			await decide(env.team.headUser.id, id, "reject", "private-reason-words");
			expect(emailJobs.length).toBe(1);
			const job = emailJobs[0];
			expect(job?.name).toBe("decision");
			expect(job?.data.message).toEqual({
				to: env.team.staffUser.email,
				subject: "Your report needs changes",
			});
			expect(job?.data.message.to).toMatch(/@example\.com$/);
			expect(job?.data.template).toBe("decision");
			expect(job?.data.idempotencyKey).toMatch(/^decision:\d+$/);
			expect(job?.data.locals.reportUrl).toBe(
				`${config.frontendUrl}/dashboard/reports/${id}`,
			);
			expect(JSON.stringify(job?.data)).not.toContain("private-reason-words");

			await decide(env.team.admin.id, id, "approve");
			expect(emailJobs.map((j) => j.data.message.subject)).toEqual([
				"Your report needs changes",
				"Your report was approved",
			]);
			expect(emailJobs[0]?.data.idempotencyKey).not.toBe(
				emailJobs[1]?.data.idempotencyKey,
			);
		});

		it("queues nothing for reopen, comments, tasks or submissions", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			await req(env.team.headUser.id, "POST", `/reports/${id}/comments`, {
				body: "x",
				followUp: {
					title: "t",
					assigneeMembershipId: String(env.team.staffM.id),
					dueAt: "2026-11-04",
					priority: "low",
				},
			});
			expect(emailJobs).toEqual([]);
			await decide(env.team.headUser.id, id, "approve");
			resetQueue();
			await decide(env.team.headUser.id, id, "reopen", "again");
			expect(emailJobs).toEqual([]);
		});

		it("queues nothing when DECISION_EMAILS_ENABLED is off, and still notifies in-app", async () => {
			switchable.decisionEmailsEnabled = false;
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			await decide(env.team.headUser.id, id, "approve");
			expect(emailJobs).toEqual([]);
			expect((await rows(env.team.staffUser.id)).map((r) => r.type)).toEqual([
				"decision",
			]);
		});

		it("queues per approved report in a bulk approve", async () => {
			const a = await submitReport(req, env.team.staffUser.id, env.periodId);
			const b = await submitReport(req, env.staff2.userId, env.periodId);
			await req(env.team.admin.id, "POST", "/review/bulk-approve", {
				workspaceId: String(env.ws),
				reportIds: [a, b],
			});
			expect(emailJobs.length).toBe(2);
		});

		it("keeps the decision when the queue fails, and logs no email address", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			queueBehaviour.fail = true;
			/* @info - Winston's console transport can bypass console spies, so the logger itself is
			 * watched too: every entry a child logger writes goes through the root `write`. */
			const entries: string[] = [];
			const spy = vi.spyOn(logger, "write").mockImplementation(((
				info: unknown,
			) => {
				entries.push(JSON.stringify(info));
				return true;
			}) as typeof logger.write);
			const logs = captureLogs();
			const res = await decide(env.team.headUser.id, id, "approve").finally(
				() => {
					logs.stop();
					spy.mockRestore();
				},
			);
			expect(res.status).toBe(200);
			expect(res.data.reviewStatus).toBe("approved");
			const text = `${logs.text()}\n${entries.join("\n")}`;
			expect(text).toContain(`Decision email not queued for report ${id}`);
			expect(text).not.toContain(env.team.staffUser.email);
			expect(text).not.toMatch(/@example\.com/);
		});

		it("skips the email for a deactivated author", async () => {
			const id = await submitReport(req, env.team.staffUser.id, env.periodId);
			await q(
				`update memberships set active = false where id = ${env.team.staffM.id}`,
			);
			await decide(env.team.headUser.id, id, "approve");
			expect(emailJobs).toEqual([]);
		});
	});
});
