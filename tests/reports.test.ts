/**
 * Reports over HTTP on the real test Postgres (E5 to E11, AC10 to AC23, AC28 to AC31).
 * Time is fixed with fake Date. `firstSeenAt`, `windowStartedAt` and review decisions are seeded
 * with SQL: setting them is the review slice.
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
import { captureLogs } from "./helpers/log-capture";

/* @info - Wednesday 28 October 2026 12:00 Africa/Lagos. */
const NOW = "2026-10-28T11:00:00.000Z";
/* @info - Week of 26 October: open and on time at NOW. */
const CUR = {
	startsAt: "2026-10-25T23:00:00.000Z",
	endsAt: "2026-11-01T22:59:59.000Z",
	dueAt: "2026-11-02T16:00:00.000Z",
};
const DUE_MS = Date.parse(CUR.dueAt);
const GRACE = 7 * 24 * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const LONG = `<p>${"Met every partner on the list and closed five tickets."}</p>`;
const q = async (text: string) =>
	(await getDb().execute(sql.raw(text))).rows as Record<string, any>[];

describe("reports", () => {
	let app: Hono;
	let team: Awaited<ReturnType<typeof createTeam>>;
	let ws: number;
	let periodId: number;
	let staff2: { userId: number; membershipId: number };

	/* @info - A fresh session at the current fake time, so moving the clock never expires it. */
	const req = async (
		userId: number,
		method: string,
		path: string,
		body?: unknown,
	) => call(app, method, path, { headers: await sessionFor(userId), body });
	const save = (userId: number, body: Record<string, unknown>) =>
		req(userId, "PATCH", "/reports/draft", {
			periodId: String(periodId),
			...body,
		});
	const submit = (userId: number, id: string) =>
		req(userId, "POST", `/reports/${id}/submit`);
	const setNow = (t: string | number) => vi.setSystemTime(new Date(t));
	/** @info - A submitted report by Staff in the current period. */
	const submitted = async (userId = team.staffUser.id) => {
		const draft = await save(userId, { accomplishments: LONG });
		expect(draft.status).toBe(200);
		const res = await submit(userId, draft.data.id);
		expect(res.status).toBe(200);
		return res.data.id as string;
	};

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
		const u = await createUser();
		const m = await addMember(ws, u.id, "staff", team.space.id);
		staff2 = { userId: u.id, membershipId: m.id };
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe("E6 draft save and E5 draft read", () => {
		it("saves a draft with the documented shape and the Space KPI snapshot (AC10, AC16)", async () => {
			await q(
				`update spaces set kpi_template = '[{"name":"Calls","unit":"count"},{"name":"Calls","unit":"other"},{"name":"Visits","unit":"count"}]' where id = ${team.space.id}`,
			);
			const res = await save(team.staffUser.id, {
				accomplishments: "<p>Did <strong>work</strong></p>",
				challenges: "<p>None</p>",
				plans: "",
				kpis: [
					{ name: "Calls", unit: "ignored", value: 0 },
					{ name: "Unknown", value: 4 },
				],
				attachments: [
					{
						name: "notes.pdf",
						size: 1200,
						type: "application/pdf",
						uploaded: true,
					},
				],
				taggedMembershipIds: [String(staff2.membershipId)],
				location: { latitude: 6.5, longitude: 3.4, accuracy: 20 },
			});
			expect(res.status).toBe(200);
			expect(res.data).toEqual({
				id: expect.stringMatching(/^[1-9][0-9]*$/),
				periodId: String(periodId),
				authorMembershipId: String(team.staffM.id),
				accomplishments: "<p>Did <strong>work</strong></p>",
				challenges: "<p>None</p>",
				plans: "",
				kpis: [
					{ name: "Calls", unit: "count", value: 0 },
					{ name: "Calls", unit: "other", value: null },
					{ name: "Visits", unit: "count", value: null },
				],
				attachments: [
					{
						name: "notes.pdf",
						size: 1200,
						type: "application/pdf",
						uploaded: false,
					},
				],
				taggedMembershipIds: [String(staff2.membershipId)],
				location: { latitude: 6.5, longitude: 3.4, accuracy: 20 },
				submissionStatus: "draft",
				reviewStatus: "pending",
				updatedAt: NOW,
			});
			/* @info - R4: a later template change does not touch the report. */
			await q(
				`update spaces set kpi_template = '[]' where id = ${team.space.id}`,
			);
			const again = await req(
				team.staffUser.id,
				"GET",
				`/reports/draft?periodId=${periodId}`,
			);
			expect(again.status).toBe(200);
			expect(again.data.kpis).toHaveLength(3);
			expect(again.data.id).toBe(res.data.id);
		});
		it("returns null when the caller has no draft", async () => {
			const res = await req(
				team.staffUser.id,
				"GET",
				`/reports/draft?periodId=${periodId}`,
			);
			expect(res.status).toBe(200);
			expect(res.data).toBeNull();
		});
		it("keeps one row for five parallel saves and loses no field (AC10)", async () => {
			const bodies = [
				{ accomplishments: "<p>a</p>" },
				{ challenges: "<p>c</p>" },
				{ plans: "<p>p</p>" },
				{ location: { latitude: 1, longitude: 2, accuracy: 3 } },
				{ attachments: [{ name: "x.txt", size: 1, type: "text/plain" }] },
			];
			const results = await Promise.all(
				bodies.map((b) => save(team.staffUser.id, b)),
			);
			expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
			const rows = await q(
				`select * from reports where period_id = ${periodId}`,
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				accomplishments: "<p>a</p>",
				challenges: "<p>c</p>",
				plans: "<p>p</p>",
				location: { latitude: 1, longitude: 2, accuracy: 3 },
			});
			expect(rows[0]?.attachments).toHaveLength(1);
		});
		it("refuses an Admin with ADMIN_CANNOT_AUTHOR on save and read (AC11)", async () => {
			for (const res of [
				await save(team.admin.id, { accomplishments: "<p>x</p>" }),
				await req(team.admin.id, "GET", `/reports/draft?periodId=${periodId}`),
			]) {
				expect(res.status).toBe(403);
				expect(res.error.code).toBe("ADMIN_CANNOT_AUTHOR");
			}
		});
		it("refuses a draft in a period that has not started (PERIOD_NOT_OPEN, seeded)", async () => {
			const future = await createPeriod(
				ws,
				"2026-11-01T23:00:00Z",
				"2026-11-08T22:59:59Z",
				"2026-11-09T16:00:00Z",
			);
			const res = await req(team.staffUser.id, "PATCH", "/reports/draft", {
				periodId: String(future.id),
			});
			expect(res.status).toBe(409);
			expect(res.error.code).toBe("PERIOD_NOT_OPEN");
		});
		it("strips script, onerror and javascript: links before storing (AC21)", async () => {
			const res = await save(team.staffUser.id, {
				accomplishments:
					'<p>ok</p><script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)" onclick="x()">l</a>',
			});
			expect(res.status).toBe(200);
			const expected =
				'<p>ok</p><a target="_blank" rel="noopener noreferrer">l</a>';
			expect(res.data.accomplishments).toBe(expected);
			const [row] = await q(
				`select accomplishments from reports where id = ${res.data.id}`,
			);
			expect(row?.accomplishments).toBe(expected);
		});
	});

	describe("field errors (AC22)", () => {
		const cases: [string, Record<string, unknown>, string][] = [
			["unknown key", { authorMembershipId: "1" }, "authorMembershipId"],
			["KPI value", { kpis: [{ name: "A", value: "x" }] }, "kpis.0.value"],
			[
				"too many KPIs",
				{
					kpis: Array.from({ length: 31 }, (_, i) => ({
						name: `k${i}`,
						value: 1,
					})),
				},
				"kpis",
			],
			[
				"latitude",
				{ location: { latitude: 100, longitude: 0, accuracy: 1 } },
				"location.latitude",
			],
			[
				"attachment size",
				{ attachments: [{ name: "a", size: -1, type: "" }] },
				"attachments.0.size",
			],
			[
				"too many attachments",
				{
					attachments: Array.from({ length: 11 }, () => ({
						name: "a",
						size: 1,
						type: "",
					})),
				},
				"attachments",
			],
			[
				"six tags",
				{ taggedMembershipIds: ["1", "2", "3", "4", "5", "6"] },
				"taggedMembershipIds",
			],
			[
				"raw HTML over 20000",
				{ accomplishments: "a".repeat(20001) },
				"accomplishments",
			],
			[
				"visible text over 5000",
				{ challenges: `<p>${"a".repeat(5001)}</p>` },
				"challenges",
			],
			["id out of range", { periodId: "2147483648" }, "periodId"],
		];
		for (const [name, body, key] of cases) {
			it(`keys ${name} as ${key}`, async () => {
				const res = await save(team.staffUser.id, body);
				expect(res.status).toBe(400);
				expect(Object.keys(res.error)).toContain(key);
			});
		}
		it("refuses a self tag, a tag from another Workspace and an inactive colleague", async () => {
			const other = await createTeam();
			await q(
				`update memberships set active = false where id = ${staff2.membershipId}`,
			);
			for (const id of [team.staffM.id, other.staffM.id, staff2.membershipId]) {
				const res = await save(team.staffUser.id, {
					taggedMembershipIds: [String(id)],
				});
				expect(res.status).toBe(400);
				expect(Object.keys(res.error)).toEqual(["taggedMembershipIds"]);
			}
		});
		it("accepts exactly 5000 visible characters", async () => {
			const res = await save(team.staffUser.id, {
				plans: `<p>${"a".repeat(5000)}</p>`,
			});
			expect(res.status).toBe(200);
		});
	});

	describe("E7 submit and lateness (AC14, AC15, AC30)", () => {
		it("submits on time at exactly dueAt with the documented Report shape", async () => {
			const draft = await save(team.staffUser.id, { accomplishments: LONG });
			setNow(DUE_MS);
			const res = await submit(team.staffUser.id, draft.data.id);
			expect(res.status).toBe(200);
			expect(res.data).toMatchObject({
				id: draft.data.id,
				submissionStatus: "submitted",
				reviewStatus: "pending",
				submittedAt: CUR.dueAt,
				firstSeenAt: null,
				windowStartedAt: null,
				editWindowMinutes: 30,
				revisions: [],
				comments: [],
			});
			expect(res.data.events).toEqual([
				{
					kind: "submitted",
					at: CUR.dueAt,
					actorMembershipId: String(team.staffM.id),
				},
			]);
			const audit = await q(
				`select action, summary from audit_logs where workspace_id = ${ws}`,
			);
			expect(audit.map((a) => a.action)).toContain("report.submitted");
		});
		it("marks late one second after dueAt, keeps a draft across the deadline, accepts at dueAt + 168h", async () => {
			const a = await save(team.staffUser.id, { accomplishments: LONG });
			setNow(DUE_MS + 1000);
			const late = await submit(team.staffUser.id, a.data.id);
			expect(late.data.submissionStatus).toBe("late");
			setNow(NOW);
			const b = await save(staff2.userId, { accomplishments: LONG });
			setNow(DUE_MS + GRACE);
			const edge = await submit(staff2.userId, b.data.id);
			expect(edge.status).toBe(200);
			expect(edge.data.submissionStatus).toBe("late");
		});
		it("closes the period one second after dueAt + 168h for submit and save", async () => {
			const draft = await save(team.staffUser.id, { accomplishments: LONG });
			setNow(DUE_MS + GRACE + 1000);
			for (const res of [
				await submit(team.staffUser.id, draft.data.id),
				await save(team.staffUser.id, { plans: "<p>x</p>" }),
			]) {
				expect(res.status).toBe(409);
				expect(res.error.code).toBe("PERIOD_CLOSED");
			}
			const kept = await req(
				team.staffUser.id,
				"GET",
				`/reports/draft?periodId=${periodId}`,
			);
			expect(kept.data.accomplishments).toBe(LONG);
		});
		it("needs 50 visible characters, and refuses a second submit and a later save", async () => {
			const short = await save(team.staffUser.id, {
				accomplishments: `<p>${"a".repeat(49)}</p>`,
			});
			const res = await submit(team.staffUser.id, short.data.id);
			expect(res.status).toBe(400);
			expect(res.error).toEqual({
				accomplishments: "Write at least 50 characters.",
			});
			await save(team.staffUser.id, {
				accomplishments: `<p>${"a".repeat(50)}</p>`,
			});
			expect((await submit(team.staffUser.id, short.data.id)).status).toBe(200);
			for (const again of [
				await submit(team.staffUser.id, short.data.id),
				await save(team.staffUser.id, { plans: "<p>x</p>" }),
			]) {
				expect(again.status).toBe(409);
				expect(again.error.code).toBe("ALREADY_SUBMITTED");
			}
		});
		it("answers E5 null after submit and E8 finds it by period (AC30)", async () => {
			const id = await submitted();
			const draft = await req(
				team.staffUser.id,
				"GET",
				`/reports/draft?periodId=${periodId}`,
			);
			expect(draft.data).toBeNull();
			const list = await req(
				team.staffUser.id,
				"GET",
				`/reports?workspaceId=${ws}&periodId=${periodId}`,
			);
			expect(list.data.map((r: { id: string }) => r.id)).toEqual([id]);
		});
		it("never leaves a submitted report under 50 characters when a save races the submit", async () => {
			const draft = await save(team.staffUser.id, { accomplishments: LONG });
			await Promise.all([
				save(team.staffUser.id, { accomplishments: "<p>short</p>" }),
				submit(team.staffUser.id, draft.data.id),
			]);
			const [row] = await q(
				`select submission_status, accomplishments from reports where id = ${draft.data.id}`,
			);
			if (row?.submission_status !== "draft") {
				expect(row?.accomplishments).toBe(LONG);
			}
		});
		it("ends a delete racing a submit with no 500 (carry-over 4)", async () => {
			const draft = await save(team.staffUser.id, { accomplishments: LONG });
			const [del, sub] = await Promise.all([
				req(team.staffUser.id, "DELETE", `/reports/${draft.data.id}`),
				submit(team.staffUser.id, draft.data.id),
			]);
			expect(del.status).toBe(204);
			expect([200, 404]).toContain(sub.status);
			const [row] = await q(
				`select deleted_at from reports where id = ${draft.data.id}`,
			);
			expect(row?.deleted_at).not.toBeNull();
		});
	});

	describe("E10 edit (AC17, AC18)", () => {
		const seen = (id: string, minutesAgo: number, extra = "") =>
			q(
				`update reports set first_seen_at = '${iso(Date.parse(NOW) - minutesAgo * 60_000)}', window_started_at = '${iso(Date.parse(NOW) - minutesAgo * 60_000)}' ${extra} where id = ${id}`,
			);
		const edit = (
			id: string,
			body: Record<string, unknown> = { plans: "<p>next</p>" },
		) => req(team.staffUser.id, "PATCH", `/reports/${id}`, body);

		it("allows unseen, seen at 10 minutes and rejected; locks at 31 minutes and approved", async () => {
			const id = await submitted();
			expect((await edit(id)).status).toBe(200);
			await seen(id, 10);
			expect((await edit(id)).status).toBe(200);
			await seen(id, 31);
			const closed = await edit(id);
			expect(closed.status).toBe(403);
			expect(closed.error.code).toBe("EDIT_WINDOW_CLOSED");
			await seen(id, 31, ", review_status = 'rejected'");
			expect((await edit(id)).status).toBe(200);
			await q(`update reports set review_status = 'approved' where id = ${id}`);
			const approved = await edit(id);
			expect(approved.status).toBe(403);
			expect(approved.error.code).toBe("REPORT_APPROVED");
		});
		it("refuses a draft with NOT_SUBMITTED", async () => {
			const draft = await save(team.staffUser.id, { accomplishments: LONG });
			const res = await edit(draft.data.id);
			expect(res.status).toBe(409);
			expect(res.error.code).toBe("NOT_SUBMITTED");
		});
		it("adds a revision of the previous content and an edited event, returns to pending and clears the window", async () => {
			const draft = await save(team.staffUser.id, {
				accomplishments: LONG,
				plans: "<p>old</p>",
			});
			setNow(DUE_MS + 1000);
			const id = (await submit(team.staffUser.id, draft.data.id)).data.id;
			await q(
				`update reports set first_seen_at = '${iso(DUE_MS + 1000)}', window_started_at = '${iso(DUE_MS + 1000)}', review_status = 'rejected' where id = ${id}`,
			);
			setNow(DUE_MS + 60_000);
			const res = await edit(id, { plans: "<p>new</p>" });
			expect(res.status).toBe(200);
			expect(res.data).toMatchObject({
				plans: "<p>new</p>",
				reviewStatus: "pending",
				windowStartedAt: null,
				submissionStatus: "late",
			});
			expect(res.data.revisions).toEqual([
				{
					at: iso(DUE_MS + 60_000),
					previous: {
						accomplishments: LONG,
						challenges: "",
						plans: "<p>old</p>",
						kpis: [],
						attachments: [],
						taggedMembershipIds: [],
						location: null,
					},
				},
			]);
			expect(res.data.events.map((e: { kind: string }) => e.kind)).toEqual([
				"submitted",
				"edited",
			]);
		});
		it("keeps the 50 character rule on the resulting content", async () => {
			const id = await submitted();
			const res = await edit(id, { accomplishments: "<p>short</p>" });
			expect(res.status).toBe(400);
			expect(Object.keys(res.error)).toEqual(["accomplishments"]);
		});
		it("allows an edit after the period closed", async () => {
			const id = await submitted();
			setNow(DUE_MS + GRACE + 60_000);
			expect((await edit(id)).status).toBe(200);
		});
		it("refuses an empty body", async () => {
			const id = await submitted();
			expect((await edit(id, {})).status).toBe(400);
		});
	});

	describe("E11 delete (AC19)", () => {
		it("deletes an unseen report, then 404, and frees the period for a new draft", async () => {
			const id = await submitted();
			expect(
				(await req(team.staffUser.id, "DELETE", `/reports/${id}`)).status,
			).toBe(204);
			expect(
				(await req(team.staffUser.id, "GET", `/reports/${id}`)).status,
			).toBe(404);
			expect(
				(await save(team.staffUser.id, { plans: "<p>again</p>" })).status,
			).toBe(200);
		});
		it("deletes the author's own draft", async () => {
			const draft = await save(team.staffUser.id, { plans: "<p>x</p>" });
			expect(
				(await req(team.staffUser.id, "DELETE", `/reports/${draft.data.id}`))
					.status,
			).toBe(204);
		});
		it("refuses a seen or approved report with REPORT_SEEN, and a reviewer with NOT_AUTHOR", async () => {
			const id = await submitted();
			const byHead = await req(team.headUser.id, "DELETE", `/reports/${id}`);
			expect(byHead.status).toBe(403);
			expect(byHead.error.code).toBe("NOT_AUTHOR");
			await q(`update reports set review_status = 'approved' where id = ${id}`);
			let res = await req(team.staffUser.id, "DELETE", `/reports/${id}`);
			expect(res.error.code).toBe("REPORT_SEEN");
			await q(
				`update reports set review_status = 'pending', first_seen_at = now() where id = ${id}`,
			);
			res = await req(team.staffUser.id, "DELETE", `/reports/${id}`);
			expect(res.status).toBe(403);
			expect(res.error.code).toBe("REPORT_SEEN");
		});
	});

	describe("reads and isolation (AC12, AC13, AC20)", () => {
		it("hides another member's draft by id, in lists and from E5", async () => {
			const draft = await save(team.staffUser.id, { accomplishments: LONG });
			for (const userId of [
				staff2.userId,
				team.headUser.id,
				team.admin.id,
				team.staffUser.id,
			]) {
				const res = await req(userId, "GET", `/reports/${draft.data.id}`);
				expect(res.status).toBe(404);
				expect(res.error).toEqual({ message: "Not found." });
			}
			const e5 = await req(
				staff2.userId,
				"GET",
				`/reports/draft?periodId=${periodId}`,
			);
			expect(e5.data).toBeNull();
			const list = await req(
				staff2.userId,
				"GET",
				`/reports?workspaceId=${ws}&status=draft`,
			);
			expect(list.data).toEqual([]);
		});
		it("lets the Space Head read Staff reports, and not another Space's", async () => {
			const id = await submitted();
			expect(
				(await req(team.headUser.id, "GET", `/reports/${id}`)).status,
			).toBe(200);
			const otherSpace = await createSpace(ws, "Field");
			const otherHead = await createUser();
			await addMember(ws, otherHead.id, "head", otherSpace.id);
			expect((await req(otherHead.id, "GET", `/reports/${id}`)).status).toBe(
				404,
			);
		});
		/* @info - Changed on purpose for V2 (an Admin may read and decide any submitted report of the
		 * Workspace): it used to expect 404 for a Staff report in a headed Space. */
		it("lets an Admin read a Head's report and a Staff report, with or without a Head in the Space", async () => {
			const headReport = await submitted(team.headUser.id);
			expect(
				(await req(team.admin.id, "GET", `/reports/${headReport}`)).status,
			).toBe(200);
			const staffReport = await submitted();
			expect(
				(await req(team.admin.id, "GET", `/reports/${staffReport}`)).status,
			).toBe(200);
			await q(
				`update spaces set head_membership_id = null where id = ${team.space.id}`,
			);
			expect(
				(await req(team.admin.id, "GET", `/reports/${staffReport}`)).status,
			).toBe(200);
		});
		it("gives a tagged colleague who is not a reviewer 404", async () => {
			await save(team.staffUser.id, {
				accomplishments: LONG,
				taggedMembershipIds: [String(staff2.membershipId)],
			});
			const draft = await req(
				team.staffUser.id,
				"GET",
				`/reports/draft?periodId=${periodId}`,
			);
			const id = (await submit(team.staffUser.id, draft.data.id)).data.id;
			expect((await req(staff2.userId, "GET", `/reports/${id}`)).status).toBe(
				404,
			);
		});
		it("gives the same 404 for another Workspace, a deleted report, a non-member and a deactivated member", async () => {
			const id = await submitted();
			const other = await createTeam();
			const stranger = await createUser();
			for (const userId of [other.staffUser.id, other.admin.id, stranger.id]) {
				for (const [method, path] of [
					["GET", `/reports/${id}`],
					["PATCH", `/reports/${id}`],
					["DELETE", `/reports/${id}`],
					["POST", `/reports/${id}/submit`],
				] as const) {
					const res = await req(
						userId,
						method,
						path,
						method === "PATCH" ? { plans: "<p>x</p>" } : undefined,
					);
					expect(res.status, `${method} ${path}`).toBe(404);
					expect(res.error).toEqual({ message: "Not found." });
				}
				const draft = await req(
					userId,
					"GET",
					`/reports/draft?periodId=${periodId}`,
				);
				expect(draft.status).toBe(404);
				const list = await req(userId, "GET", `/reports?workspaceId=${ws}`);
				expect(list.status).toBe(404);
			}
			await q(
				`update memberships set active = false where id = ${team.headM.id}`,
			);
			expect(
				(await req(team.headUser.id, "GET", `/reports/${id}`)).status,
			).toBe(404);
			await q(`update reports set deleted_at = now() where id = ${id}`);
			const gone = await req(team.staffUser.id, "GET", `/reports/${id}`);
			expect(gone.status).toBe(404);
			expect(gone.error).toEqual({ message: "Not found." });
		});
		it("answers 400 Invalid id for an id past the integer range on every route", async () => {
			const big = "2147483648";
			for (const [method, path] of [
				["GET", `/reports/${big}`],
				["PATCH", `/reports/${big}`],
				["DELETE", `/reports/${big}`],
				["POST", `/reports/${big}/submit`],
				["GET", `/reports/draft?periodId=${big}`],
				["GET", `/reports?workspaceId=${big}`],
			] as const) {
				const res = await req(
					team.staffUser.id,
					method,
					path,
					method === "PATCH" ? { plans: "<p>x</p>" } : undefined,
				);
				expect(res.status, path).toBe(400);
				expect(Object.values(res.error)).toContain("Invalid id.");
			}
		});
		it("gives a suspended person 401 on E5 to E11", async () => {
			const id = await submitted();
			await q(
				`update users set suspended_at = now() where id = ${team.staffUser.id}`,
			);
			for (const [method, path, body] of [
				["GET", `/reports/draft?periodId=${periodId}`, undefined],
				["PATCH", "/reports/draft", { periodId: String(periodId) }],
				["POST", `/reports/${id}/submit`, undefined],
				["GET", `/reports?workspaceId=${ws}`, undefined],
				["GET", `/reports/${id}`, undefined],
				["PATCH", `/reports/${id}`, { plans: "<p>x</p>" }],
				["DELETE", `/reports/${id}`, undefined],
			] as const) {
				const res = await req(team.staffUser.id, method, path, body);
				expect(res.status, `${method} ${path}`).toBe(401);
			}
		});
	});

	describe("E8 list", () => {
		it("lists own submitted reports newest first, drafts with status=draft, and [] for an Admin", async () => {
			const prev = await createPeriod(
				ws,
				"2026-10-18T23:00:00Z",
				"2026-10-25T22:59:59Z",
				"2026-10-26T16:00:00Z",
			);
			const older = await req(team.staffUser.id, "PATCH", "/reports/draft", {
				periodId: String(prev.id),
				accomplishments: LONG,
			});
			await submit(team.staffUser.id, older.data.id);
			setNow(Date.parse(NOW) + 60_000);
			const newer = await submitted();
			const list = await req(
				team.staffUser.id,
				"GET",
				`/reports?workspaceId=${ws}`,
			);
			expect(list.data.map((r: { id: string }) => r.id)).toEqual([
				newer,
				older.data.id,
			]);
			expect(list.data[1].submissionStatus).toBe("late");
			expect(
				(await req(team.admin.id, "GET", `/reports?workspaceId=${ws}`)).data,
			).toEqual([]);
			const page = await req(
				team.staffUser.id,
				"GET",
				`/reports?workspaceId=${ws}&limit=1&offset=1`,
			);
			expect(page.data.map((r: { id: string }) => r.id)).toEqual([
				older.data.id,
			]);
			for (const bad of ["limit=101", "limit=0", "offset=-1", "status=late"]) {
				const res = await req(
					team.staffUser.id,
					"GET",
					`/reports?workspaceId=${ws}&${bad}`,
				);
				expect(res.status, bad).toBe(400);
			}
		});
	});

	describe("order of checks (D30, AC28)", () => {
		const closeNow = () => setNow(DUE_MS + GRACE + 1000);
		const readOnly = () =>
			q(`update workspaces set read_only = true where id = ${ws}`);
		const expectCode = (
			res: { status: number; error: any },
			status: number,
			code: string,
		) => {
			expect(res.status).toBe(status);
			expect(res.error.code).toBe(code);
		};
		it("E6: 404 before ADMIN_CANNOT_AUTHOR", async () => {
			const other = await createTeam();
			const res = await save(other.admin.id, {});
			expect(res.status).toBe(404);
		});
		it("E6: ADMIN_CANNOT_AUTHOR before NO_SPACE and before a closed period", async () => {
			closeNow();
			expectCode(await save(team.admin.id, {}), 403, "ADMIN_CANNOT_AUTHOR");
		});
		it("E6: NO_SPACE before WORKSPACE_READ_ONLY (defensive, CHECK dropped for the test)", async () => {
			await q(
				`alter table memberships drop constraint memberships_admin_space_chk`,
			);
			try {
				await q(
					`update memberships set space_id = null where id = ${team.staffM.id}`,
				);
				await readOnly();
				expectCode(await save(team.staffUser.id, {}), 409, "NO_SPACE");
				expectCode(
					await req(
						team.staffUser.id,
						"GET",
						`/reports/draft?periodId=${periodId}`,
					),
					409,
					"NO_SPACE",
				);
			} finally {
				await q(
					`update memberships set space_id = ${team.space.id} where id = ${team.staffM.id}`,
				);
				await q(
					`alter table memberships add constraint memberships_admin_space_chk check ((role = 'admin') = (space_id is null))`,
				);
			}
		});
		it("E6: WORKSPACE_READ_ONLY before PERIOD_CLOSED, and before content errors", async () => {
			await readOnly();
			closeNow();
			expectCode(
				await save(team.staffUser.id, { plans: `<p>${"a".repeat(5001)}</p>` }),
				403,
				"WORKSPACE_READ_ONLY",
			);
		});
		it("E6: PERIOD_NOT_OPEN before PERIOD_CLOSED is unreachable together; PERIOD_CLOSED before content errors", async () => {
			closeNow();
			expectCode(
				await save(team.staffUser.id, { plans: `<p>${"a".repeat(5001)}</p>` }),
				409,
				"PERIOD_CLOSED",
			);
		});
		it("E6: content errors before ALREADY_SUBMITTED", async () => {
			await submitted();
			const res = await save(team.staffUser.id, {
				plans: `<p>${"a".repeat(5001)}</p>`,
			});
			expect(res.status).toBe(400);
		});
		it("E7: NOT_AUTHOR before ADMIN_CANNOT_AUTHOR (an Admin who can read a Head's report)", async () => {
			const draft = await save(team.headUser.id, { accomplishments: LONG });
			const id = (await submit(team.headUser.id, draft.data.id)).data.id;
			expectCode(await submit(team.admin.id, id), 403, "NOT_AUTHOR");
		});
		it("E7: ADMIN_CANNOT_AUTHOR before WORKSPACE_READ_ONLY (an author later made Admin)", async () => {
			const draft = await save(team.staffUser.id, { accomplishments: LONG });
			await q(
				`update memberships set role = 'admin', space_id = null where id = ${team.staffM.id}`,
			);
			await readOnly();
			expectCode(
				await submit(team.staffUser.id, draft.data.id),
				403,
				"ADMIN_CANNOT_AUTHOR",
			);
		});
		it("E7: WORKSPACE_READ_ONLY before ALREADY_SUBMITTED", async () => {
			const id = await submitted();
			await readOnly();
			expectCode(
				await submit(team.staffUser.id, id),
				403,
				"WORKSPACE_READ_ONLY",
			);
		});
		it("E7: ALREADY_SUBMITTED before PERIOD_CLOSED", async () => {
			const id = await submitted();
			closeNow();
			expectCode(await submit(team.staffUser.id, id), 409, "ALREADY_SUBMITTED");
		});
		it("E7: PERIOD_CLOSED before the 50 character rule", async () => {
			const draft = await save(team.staffUser.id, {
				accomplishments: "<p>short</p>",
			});
			closeNow();
			expectCode(
				await submit(team.staffUser.id, draft.data.id),
				409,
				"PERIOD_CLOSED",
			);
		});
		it("E7: 404 before NOT_AUTHOR (a stranger to the report)", async () => {
			const draft = await save(team.staffUser.id, { accomplishments: LONG });
			const res = await submit(staff2.userId, draft.data.id);
			expect(res.status).toBe(404);
		});
		it("E10: NOT_AUTHOR before ADMIN_CANNOT_AUTHOR and WORKSPACE_READ_ONLY (a Head editing a Staff report)", async () => {
			const id = await submitted();
			await readOnly();
			expectCode(
				await req(team.headUser.id, "PATCH", `/reports/${id}`, {
					plans: "<p>x</p>",
				}),
				403,
				"NOT_AUTHOR",
			);
		});
		it("E10: ADMIN_CANNOT_AUTHOR before WORKSPACE_READ_ONLY", async () => {
			const id = await submitted();
			await q(
				`update memberships set role = 'admin', space_id = null where id = ${team.staffM.id}`,
			);
			await readOnly();
			expectCode(
				await req(team.staffUser.id, "PATCH", `/reports/${id}`, {
					plans: "<p>x</p>",
				}),
				403,
				"ADMIN_CANNOT_AUTHOR",
			);
		});
		it("E10: WORKSPACE_READ_ONLY before NOT_SUBMITTED", async () => {
			const draft = await save(team.staffUser.id, { accomplishments: LONG });
			await readOnly();
			expectCode(
				await req(team.staffUser.id, "PATCH", `/reports/${draft.data.id}`, {
					plans: "<p>x</p>",
				}),
				403,
				"WORKSPACE_READ_ONLY",
			);
		});
		it("E10: NOT_SUBMITTED before REPORT_APPROVED", async () => {
			const draft = await save(team.staffUser.id, { accomplishments: LONG });
			await q(
				`update reports set review_status = 'approved' where id = ${draft.data.id}`,
			);
			expectCode(
				await req(team.staffUser.id, "PATCH", `/reports/${draft.data.id}`, {
					plans: "<p>x</p>",
				}),
				409,
				"NOT_SUBMITTED",
			);
		});
		it("E10: REPORT_APPROVED before EDIT_WINDOW_CLOSED", async () => {
			const id = await submitted();
			await q(
				`update reports set review_status = 'approved', first_seen_at = '2026-10-27T00:00:00Z', window_started_at = '2026-10-27T00:00:00Z' where id = ${id}`,
			);
			expectCode(
				await req(team.staffUser.id, "PATCH", `/reports/${id}`, {
					plans: "<p>x</p>",
				}),
				403,
				"REPORT_APPROVED",
			);
		});
		it("E10: EDIT_WINDOW_CLOSED before content errors", async () => {
			const id = await submitted();
			await q(
				`update reports set first_seen_at = '2026-10-27T00:00:00Z', window_started_at = '2026-10-27T00:00:00Z' where id = ${id}`,
			);
			expectCode(
				await req(team.staffUser.id, "PATCH", `/reports/${id}`, {
					accomplishments: "<p>short</p>",
				}),
				403,
				"EDIT_WINDOW_CLOSED",
			);
		});
		it("E11: 404 before NOT_AUTHOR, NOT_AUTHOR before REPORT_SEEN", async () => {
			const id = await submitted();
			await q(`update reports set first_seen_at = now() where id = ${id}`);
			expect(
				(await req(staff2.userId, "DELETE", `/reports/${id}`)).status,
			).toBe(404);
			expectCode(
				await req(team.headUser.id, "DELETE", `/reports/${id}`),
				403,
				"NOT_AUTHOR",
			);
		});
		it("E11: a read-only Workspace still allows delete (AC11)", async () => {
			const id = await submitted();
			await readOnly();
			expect(
				(await req(team.staffUser.id, "DELETE", `/reports/${id}`)).status,
			).toBe(204);
		});
	});

	describe("logs and failures (AC23)", () => {
		it("writes no report text, KPI value or location to any log on save, submit and edit", async () => {
			const secret =
				"SECRETWORD-91c2 progress that must never be logged by anything";
			const logs = captureLogs();
			try {
				const draft = await save(team.staffUser.id, {
					accomplishments: `<p>${secret}</p>`,
					kpis: [{ name: "Calls", value: 987654 }],
					location: { latitude: 6.123456, longitude: 3.654321, accuracy: 5 },
				});
				const id = (await submit(team.staffUser.id, draft.data.id)).data.id;
				await req(team.staffUser.id, "PATCH", `/reports/${id}`, {
					plans: `<p>${secret}</p>`,
				});
				await req(team.staffUser.id, "GET", `/reports/${id}`);
			} finally {
				logs.stop();
			}
			expect(logs.text()).not.toContain("SECRETWORD");
			expect(logs.text()).not.toContain("987654");
			expect(logs.text()).not.toContain("6.123456");
		});
		it("answers a failing write with the generic 500 and no sentinel in the body or logs", async () => {
			await q(
				`alter table reports add constraint reports_sentinel_chk check (accomplishments not like '%SENTINEL%')`,
			);
			const logs = captureLogs();
			let res: Awaited<ReturnType<typeof save>>;
			try {
				res = await save(team.staffUser.id, {
					accomplishments: "<p>SENTINEL-abc</p>",
				});
			} finally {
				logs.stop();
				await q(
					`alter table reports drop constraint if exists reports_sentinel_chk`,
				);
			}
			expect(res.status).toBe(500);
			expect(res.error).toEqual({
				message: "Something went wrong. Try again.",
			});
			expect(JSON.stringify(res.json)).not.toContain("SENTINEL");
			expect(logs.text()).not.toContain("SENTINEL");
			expect(logs.text()).toContain('"pgCode":"23514"');
		});
	});
});
