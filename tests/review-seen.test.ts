/**
 * Seen, the edit window and the reviewer relation (AC7, AC8 and the V1 order of checks) over HTTP
 * on the real test Postgres. Time is fixed with fake Date.
 */
import "./helpers/auth";
import { sql } from "drizzle-orm";
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
import { getDb } from "@/db/postgres.db";
import { buildApp, call } from "./helpers/app";
import { sessionFor } from "./helpers/auth";
import { resetTestDb, setupTestDb } from "./helpers/db";
import {
	addMember,
	createPeriod,
	createSpace,
	createTeam,
	createUser,
} from "./helpers/factories";

const NOW = "2026-10-28T11:00:00.000Z";
const CUR = {
	startsAt: "2026-10-25T23:00:00.000Z",
	endsAt: "2026-11-01T22:59:59.000Z",
	dueAt: "2026-11-02T16:00:00.000Z",
};
const LONG = `<p>${"Met every partner on the list and closed five tickets."}</p>`;
const MIN = 60_000;
const q = async (text: string) =>
	(await getDb().execute(sql.raw(text))).rows as Record<string, any>[];

describe("review seen and reviewer relation", () => {
	let app: Hono;
	let team: Awaited<ReturnType<typeof createTeam>>;
	let ws: number;
	let periodId: number;
	const req = async (
		userId: number,
		method: string,
		path: string,
		body?: unknown,
	) => call(app, method, path, { headers: await sessionFor(userId), body });
	const setNow = (t: string | number) => vi.setSystemTime(new Date(t));
	const at = (minutes: number) => Date.parse(NOW) + minutes * MIN;
	const submitted = async (userId = team.staffUser.id) => {
		const draft = await req(userId, "PATCH", "/reports/draft", {
			periodId: String(periodId),
			accomplishments: LONG,
		});
		expect(draft.status).toBe(200);
		const res = await req(userId, "POST", `/reports/${draft.data.id}/submit`);
		expect(res.status).toBe(200);
		return res.data.id as string;
	};
	const seen = (userId: number, id: string) =>
		req(userId, "POST", `/reports/${id}/seen`);
	const edit = (id: string) =>
		req(team.staffUser.id, "PATCH", `/reports/${id}`, { plans: "<p>x</p>" });
	const events = async (id: string, kind: string) =>
		(
			await q(
				`select id from report_events where report_id = ${id} and kind = '${kind}'`,
			)
		).length;

	beforeAll(async () => {
		await setupTestDb();
		app = await buildApp();
	});
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		setNow(NOW);
		await resetTestDb();
		team = await createTeam();
		ws = team.workspace.id;
		await q(
			`update workspaces set time_zone = 'Africa/Lagos', created_at = '2026-10-01T00:00:00Z' where id = ${ws}`,
		);
		periodId = (
			await createPeriod(
				ws,
				CUR.startsAt,
				CUR.endsAt,
				CUR.dueAt,
				"Week of 26 October",
			)
		).id;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe("POST /reports/:id/seen (E12)", () => {
		it("sets both times and writes one seen event for the Head of the Space, and a second call changes nothing", async () => {
			const id = await submitted();
			const first = await seen(team.headUser.id, id);
			expect(first.status).toBe(200);
			expect(first.data).toEqual({ firstSeenAt: NOW, windowStartedAt: NOW });
			expect(await events(id, "seen")).toBe(1);

			setNow(at(5));
			const second = await seen(team.headUser.id, id);
			expect(second.status).toBe(200);
			expect(second.data).toEqual({ firstSeenAt: NOW, windowStartedAt: NOW });
			expect(await events(id, "seen")).toBe(1);
		});

		it("starts the window for an Admin only when the Space has no Head", async () => {
			const id = await submitted();
			const blocked = await seen(team.admin.id, id);
			expect(blocked.status).toBe(403);
			expect(blocked.error.code).toBe("NOT_REVIEWER");
			await q(
				`update spaces set head_membership_id = null where id = ${team.space.id}`,
			);
			const ok = await seen(team.admin.id, id);
			expect(ok.status).toBe(200);
			expect(ok.data.windowStartedAt).toBe(NOW);
		});

		it("lets a non-designated Admin read the report without starting the lock (D9)", async () => {
			const id = await submitted();
			const read = await req(team.admin.id, "GET", `/reports/${id}`);
			expect(read.status).toBe(200);
			expect(read.data.firstSeenAt).toBeNull();
			expect(read.data.windowStartedAt).toBeNull();
			expect((await seen(team.admin.id, id)).status).toBe(403);
			const [row] = await q(
				`select first_seen_at, window_started_at from reports where id = ${id}`,
			);
			expect(row).toEqual({ first_seen_at: null, window_started_at: null });
		});

		it("gives the author 403 NOT_REVIEWER and every other caller 404 (the author cannot start their own lock)", async () => {
			const id = await submitted();
			const own = await seen(team.staffUser.id, id);
			expect(own.status).toBe(403);
			expect(own.error.code).toBe("NOT_REVIEWER");

			const colleague = await createUser();
			await addMember(ws, colleague.id, "staff", team.space.id);
			const otherSpace = await createSpace(ws, "Field");
			const otherHead = await createUser();
			await addMember(ws, otherHead.id, "head", otherSpace.id);
			const other = await createTeam();
			const stranger = await createUser();
			for (const userId of [
				colleague.id,
				otherHead.id,
				other.admin.id,
				other.headUser.id,
				stranger.id,
			]) {
				const res = await seen(userId, id);
				expect(res.status, String(userId)).toBe(404);
				expect(res.error).toEqual({ message: "Not found." });
			}
			const [row] = await q(
				`select first_seen_at from reports where id = ${id}`,
			);
			expect(row?.first_seen_at).toBeNull();
		});

		it("gives 404 for a draft, a deleted report and a deactivated Head, and 401 for a suspended one", async () => {
			const draft = await req(team.staffUser.id, "PATCH", "/reports/draft", {
				periodId: String(periodId),
				accomplishments: LONG,
			});
			expect((await seen(team.headUser.id, draft.data.id)).status).toBe(404);
			expect((await seen(team.staffUser.id, draft.data.id)).status).toBe(404);

			const id = await submitted();
			await q(
				`update memberships set active = false where id = ${team.headM.id}`,
			);
			expect((await seen(team.headUser.id, id)).status).toBe(404);
			await q(
				`update memberships set active = true where id = ${team.headM.id}`,
			);
			await q(
				`update users set suspended_at = now() where id = ${team.headUser.id}`,
			);
			expect((await seen(team.headUser.id, id)).status).toBe(401);
			await q(
				`update users set suspended_at = null where id = ${team.headUser.id}`,
			);
			await q(`update reports set deleted_at = now() where id = ${id}`);
			expect((await seen(team.headUser.id, id)).status).toBe(404);
		});

		it("answers 400 for a bad id", async () => {
			const res = await seen(team.headUser.id, "2147483648");
			expect(res.status).toBe(400);
		});
	});

	describe("who the reviewer is (V1: the author's role is checked first)", () => {
		it("makes the Admins, not the Head of another Space's report, the reviewers of a Head's report", async () => {
			const id = await submitted(team.headUser.id);
			expect((await seen(team.headUser.id, id)).status).toBe(403);
			const admin = await seen(team.admin.id, id);
			expect(admin.status).toBe(200);
			expect(admin.data.windowStartedAt).toBe(NOW);
		});

		it("makes the Admins the reviewers when the author is a Head in a Space whose Head is someone else", async () => {
			/* @info - A second Head-role member of the Space. addMember would move the Space's Head
			 * pointer to them, so it is put back: the designated Head stays headM. */
			const author = await createUser();
			const authorM = await addMember(ws, author.id, "head", team.space.id);
			await q(
				`update spaces set head_membership_id = ${team.headM.id} where id = ${team.space.id}`,
			);
			const id = await submitted(author.id);
			expect(authorM.id).not.toBe(team.headM.id);

			const designated = await seen(team.headUser.id, id);
			expect(designated.status).toBe(404);
			const read = await req(team.headUser.id, "GET", `/reports/${id}`);
			expect(read.status).toBe(404);
			const admin = await seen(team.admin.id, id);
			expect(admin.status).toBe(200);
		});

		it("lets the Head of the Space and an Admin read a Staff report, and not another Space's Head", async () => {
			const id = await submitted();
			expect(
				(await req(team.headUser.id, "GET", `/reports/${id}`)).status,
			).toBe(200);
			expect((await req(team.admin.id, "GET", `/reports/${id}`)).status).toBe(
				200,
			);
			const otherSpace = await createSpace(ws, "Field");
			const otherHead = await createUser();
			await addMember(ws, otherHead.id, "head", otherSpace.id);
			expect((await req(otherHead.id, "GET", `/reports/${id}`)).status).toBe(
				404,
			);
		});

		it("keeps the Admin out of the author routes (NOT_AUTHOR on edit and submit)", async () => {
			const id = await submitted();
			const res = await req(team.admin.id, "PATCH", `/reports/${id}`, {
				plans: "<p>x</p>",
			});
			expect(res.status).toBe(403);
			expect(res.error.code).toBe("NOT_AUTHOR");
			const del = await req(team.admin.id, "DELETE", `/reports/${id}`);
			expect(del.status).toBe(403);
			expect(del.error.code).toBe("NOT_AUTHOR");
		});
	});

	describe("the edit window after seen (C2, AC8)", () => {
		it("restarts the window on the next designated look, keeps firstSeenAt, and locks an edit after that window", async () => {
			const id = await submitted();
			await seen(team.headUser.id, id);

			setNow(at(10));
			const inside = await edit(id);
			expect(inside.status).toBe(200);
			expect(inside.data.windowStartedAt).toBeNull();
			expect(inside.data.firstSeenAt).toBe(NOW);

			/* @info - No reviewer has looked since the edit, so no window is running. By design
			 * the report stays editable until the next look. */
			setNow(at(90));
			expect((await edit(id)).status).toBe(200);

			setNow(at(100));
			const again = await seen(team.headUser.id, id);
			expect(again.data).toEqual({
				firstSeenAt: NOW,
				windowStartedAt: new Date(at(100)).toISOString(),
			});
			expect(await events(id, "seen")).toBe(2);

			setNow(at(125));
			expect((await edit(id)).status).toBe(200);

			setNow(at(125 + 5));
			await seen(team.headUser.id, id);
			setNow(at(125 + 5 + 31));
			const late = await edit(id);
			expect(late.status).toBe(403);
			expect(late.error.code).toBe("EDIT_WINDOW_CLOSED");
		});

		it("keeps a rejected report editable after the window, and locks delete once seen", async () => {
			const id = await submitted();
			await seen(team.headUser.id, id);
			setNow(at(60));
			await q(`update reports set review_status = 'rejected' where id = ${id}`);
			expect((await edit(id)).status).toBe(200);
			const del = await req(team.staffUser.id, "DELETE", `/reports/${id}`);
			expect(del.status).toBe(403);
			expect(del.error.code).toBe("REPORT_SEEN");
		});

		it("lets the author delete an unseen report", async () => {
			const id = await submitted();
			const del = await req(team.staffUser.id, "DELETE", `/reports/${id}`);
			expect(del.status).toBe(204);
		});
	});
});
