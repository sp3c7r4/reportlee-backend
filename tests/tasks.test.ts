/**
 * GET /tasks and PATCH /tasks/:id over HTTP on the real test Postgres (AC11, AC12, AC22).
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

const DAY = 24 * 3_600_000;

describe("tasks", () => {
	let app: Hono;
	let env: Omit<ReviewEnv, "app">;
	let req: ReturnType<typeof requester>;
	let reportId: string;
	/** @info - A follow-up from the Head to `assignee`, through the real comment route. */
	const assign = async (
		assignee: number,
		title = "Add the figures",
		by = env.team.headUser.id,
	) => {
		const res = await req(by, "POST", `/reports/${reportId}/comments`, {
			body: "Follow up",
			followUp: {
				title,
				assigneeMembershipId: String(assignee),
				dueAt: "2026-11-04",
				priority: "medium",
			},
		});
		expect(res.status).toBe(201);
		return res.data.taskId as string;
	};
	const list = (userId: number, view: string, ws = env.ws) =>
		req(userId, "GET", `/tasks?workspaceId=${ws}&view=${view}`);
	const move = (userId: number, id: string, body: Record<string, unknown>) =>
		req(userId, "PATCH", `/tasks/${id}`, body);
	const titles = (res: { data: any }) =>
		(res.data as { title: string }[]).map((t) => t.title).sort();

	beforeAll(async () => {
		app = await startApp();
		req = requester(app);
	});
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		env = await freshWorld();
		reportId = await submitReport(req, env.team.staffUser.id, env.periodId);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe("only the assignee moves a task (AC11)", () => {
		it("moves todo, doing, done and back, setting and clearing completedAt and the note", async () => {
			const id = await assign(env.team.staffM.id);
			const doing = await move(env.team.staffUser.id, id, { status: "doing" });
			expect(doing.status).toBe(200);
			expect(doing.data.status).toBe("doing");
			expect(doing.data.completedAt).toBeNull();
			const done = await move(env.team.staffUser.id, id, {
				status: "done",
				completionNote: "<b>Sent</b> the figures",
				completionFile: { name: "a.pdf", size: 1200, type: "application/pdf" },
			});
			expect(done.status).toBe(200);
			expect(done.data).toEqual({
				id,
				reportId,
				title: "Add the figures",
				assigneeMembershipId: String(env.team.staffM.id),
				assignedByMembershipId: String(env.team.headM.id),
				dueAt: "2026-11-04",
				status: "done",
				priority: "medium",
				completionNote: "Sent the figures",
				completionFile: { name: "a.pdf", size: 1200, type: "application/pdf" },
				completedAt: NOW,
				createdAt: NOW,
			});
			const back = await move(env.team.staffUser.id, id, { status: "todo" });
			expect(back.data.completedAt).toBeNull();
			expect(back.data.completionNote).toBeNull();
			expect(back.data.completionFile).toBeNull();
		});

		it("gives the assigner, another Head, an Admin and a colleague 403 NOT_ASSIGNEE", async () => {
			const id = await assign(env.team.staffM.id);
			const otherSpace = await createSpace(env.ws, "Field");
			const otherHead = await createUser();
			await addMember(env.ws, otherHead.id, "head", otherSpace.id);
			for (const userId of [
				env.team.headUser.id,
				otherHead.id,
				env.team.admin.id,
				env.staff2.userId,
			]) {
				const res = await move(userId, id, { status: "done" });
				expect(res.status, String(userId)).toBe(403);
				expect(res.error.code).toBe("NOT_ASSIGNEE");
			}
			const [row] = await q(`select status from tasks where id = ${id}`);
			expect(row?.status).toBe("todo");
		});

		it("gives another Workspace, a stranger and a missing task 404", async () => {
			const id = await assign(env.team.staffM.id);
			const other = await createTeam();
			expect(
				(await move(other.staffUser.id, id, { status: "done" })).status,
			).toBe(404);
			expect(
				(await move((await createUser()).id, id, { status: "done" })).status,
			).toBe(404);
			expect(
				(await move(env.team.staffUser.id, "999999", { status: "done" }))
					.status,
			).toBe(404);
		});

		it("refuses a note or file without done, a long note, a bad status and an unknown key", async () => {
			const id = await assign(env.team.staffM.id);
			const note = await move(env.team.staffUser.id, id, {
				status: "doing",
				completionNote: "x",
			});
			expect(note.status).toBe(400);
			expect(note.error.completionNote).toBe(
				"A note goes with a finished task.",
			);
			const long = await move(env.team.staffUser.id, id, {
				status: "done",
				completionNote: "x".repeat(1001),
			});
			expect(long.status).toBe(400);
			const bad = await move(env.team.staffUser.id, id, { status: "archived" });
			expect(bad.status).toBe(400);
			expect(bad.error.status).toBe("Choose todo, doing or done.");
			const extra = await move(env.team.staffUser.id, id, {
				status: "done",
				title: "x",
			});
			expect(extra.status).toBe(400);
			expect(extra.error.title).toBe("This field is not accepted.");
		});

		it("allows a move in a read-only Workspace (D21)", async () => {
			const id = await assign(env.team.staffM.id);
			await q(`update workspaces set read_only = true where id = ${env.ws}`);
			expect(
				(await move(env.team.staffUser.id, id, { status: "done" })).status,
			).toBe(200);
		});

		it("hides and refuses a task whose report was deleted (D25)", async () => {
			const id = await assign(env.team.staffM.id);
			await q(`update reports set deleted_at = now() where id = ${reportId}`);
			expect((await list(env.team.staffUser.id, "mine")).data).toEqual([]);
			expect(
				(await move(env.team.staffUser.id, id, { status: "done" })).status,
			).toBe(404);
		});
	});

	describe("views per role (AC12)", () => {
		it("allows staff mine; head mine, by, space; admin by, all; and refuses the rest with VIEW_NOT_ALLOWED", async () => {
			const allowed: [number, string[], string[]][] = [
				[env.team.staffUser.id, ["mine"], ["by", "space", "all"]],
				[env.team.headUser.id, ["mine", "by", "space"], ["all"]],
				[env.team.admin.id, ["by", "all"], ["mine", "space"]],
			];
			for (const [userId, ok, refused] of allowed) {
				for (const view of ok) {
					expect((await list(userId, view)).status, `${userId} ${view}`).toBe(
						200,
					);
				}
				for (const view of refused) {
					const res = await list(userId, view);
					expect(res.status, `${userId} ${view}`).toBe(403);
					expect(res.error.code).toBe("VIEW_NOT_ALLOWED");
				}
			}
			expect((await list(env.team.staffUser.id, "everything")).status).toBe(
				400,
			);
			expect((await list((await createUser()).id, "mine")).status).toBe(404);
		});

		it("returns the right tasks per view", async () => {
			await assign(env.team.staffM.id, "For staff");
			await assign(env.staff2.membershipId, "For staff2");
			/* @info - An Admin assigns on a report in a Space with no Head. */
			const field = await createSpace(env.ws, "Field");
			const fieldUser = await createUser();
			const fieldM = await addMember(env.ws, fieldUser.id, "staff", field.id);
			const fieldReport = await submitReport(req, fieldUser.id, env.periodId);
			const res = await req(
				env.team.admin.id,
				"POST",
				`/reports/${fieldReport}/comments`,
				{
					body: "x",
					followUp: {
						title: "From admin",
						assigneeMembershipId: String(fieldM.id),
						dueAt: "2026-11-05",
						priority: "low",
					},
				},
			);
			expect(res.status).toBe(201);

			expect(titles(await list(env.team.staffUser.id, "mine"))).toEqual([
				"For staff",
			]);
			expect(titles(await list(env.team.headUser.id, "by"))).toEqual([
				"For staff",
				"For staff2",
			]);
			expect(titles(await list(env.team.headUser.id, "space"))).toEqual([
				"For staff",
				"For staff2",
			]);
			expect(titles(await list(env.team.headUser.id, "mine"))).toEqual([]);
			expect(titles(await list(env.team.admin.id, "by"))).toEqual([
				"From admin",
			]);
			expect(titles(await list(env.team.admin.id, "all"))).toEqual([
				"For staff",
				"For staff2",
				"From admin",
			]);
			const other = await createTeam();
			expect(
				(await list(other.admin.id, "all", other.workspace.id)).data,
			).toEqual([]);
		});

		it("drops done tasks older than 14 days and keeps open ones however old", async () => {
			const recent = await assign(env.team.staffM.id, "Recent");
			const old = await assign(env.team.staffM.id, "Old");
			await assign(env.team.staffM.id, "Open");
			await move(env.team.staffUser.id, recent, { status: "done" });
			await move(env.team.staffUser.id, old, { status: "done" });
			await q(
				`update tasks set completed_at = '${new Date(Date.parse(NOW) - 15 * DAY).toISOString()}' where id = ${old}`,
			);
			await q(
				`update tasks set completed_at = '${new Date(Date.parse(NOW) - 13 * DAY).toISOString()}' where id = ${recent}`,
			);
			vi.setSystemTime(new Date(NOW));
			expect(titles(await list(env.team.staffUser.id, "mine"))).toEqual([
				"Open",
				"Recent",
			]);
		});
	});
});
