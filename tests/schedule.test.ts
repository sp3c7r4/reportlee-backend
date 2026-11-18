/** Schedule and reporting periods over HTTP on the real test Postgres (E1 to E4, AC1 to AC9, AC29). */
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
import { createTeam, createUser } from "./helpers/factories";

/* @info - Wednesday 28 October 2026 12:00 in Africa/Lagos (UTC+1). */
const NOW = new Date("2026-10-28T11:00:00.000Z");
const q = async (text: string) =>
	(await getDb().execute(sql.raw(text))).rows as Record<string, any>[];
const count = async (table: string, workspaceId: number) =>
	Number(
		(
			await q(
				`select count(*)::int as n from ${table} where workspace_id = ${workspaceId}`,
			)
		)[0]?.n,
	);
const weekly = {
	cadence: "weekly",
	weekday: "Friday",
	time: "17:00",
	timeZone: "Africa/Lagos",
};

describe("schedule and reporting periods", () => {
	let app: Hono;
	let team: Awaited<ReturnType<typeof createTeam>>;
	let ws: number;
	let admin: Record<string, string>;
	let head: Record<string, string>;
	let staff: Record<string, string>;
	const setNow = (iso: string | Date) => vi.setSystemTime(new Date(iso));

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
		/* @info - Fake Date does not move the database clock, so created_at is seeded. */
		await q(
			`update workspaces set time_zone = 'Africa/Lagos', created_at = '2026-10-01T00:00:00Z' where id = ${ws}`,
		);
		admin = await sessionFor(team.admin.id);
		head = await sessionFor(team.headUser.id);
		staff = await sessionFor(team.staffUser.id);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe("E1 GET schedule", () => {
		it("shows the R1 default in the Workspace zone and writes nothing (AC1)", async () => {
			const res = await call(app, "GET", `/workspaces/${ws}/schedule`, {
				headers: staff,
			});
			expect(res.status).toBe(200);
			expect(res.data).toEqual({
				cadence: "weekly",
				weekday: "Monday",
				time: "17:00",
				timeZone: "Africa/Lagos",
				dayOfMonth: null,
				lastDay: false,
				effectiveFrom: null,
				pending: null,
			});
			expect(await count("workspace_schedules", ws)).toBe(0);
			expect(await count("reporting_periods", ws)).toBe(0);
		});
		it("is 404 Workspace not found for a non-member", async () => {
			const stranger = await sessionFor((await createUser()).id);
			const res = await call(app, "GET", `/workspaces/${ws}/schedule`, {
				headers: stranger,
			});
			expect(res.status).toBe(404);
			expect(res.error).toEqual({ message: "Workspace not found." });
		});
	});

	describe("E2 PUT schedule", () => {
		it("lets an Admin change it from the next period (AC2)", async () => {
			const res = await call(app, "PUT", `/workspaces/${ws}/schedule`, {
				headers: admin,
				body: weekly,
			});
			expect(res.status).toBe(200);
			expect(res.data.appliesFrom).toBe("2026-11-01T23:00:00.000Z");
			expect(res.data.effectiveFrom).toBeNull();
			expect(res.data.weekday).toBe("Monday");
			expect(res.data.pending).toEqual({
				cadence: "weekly",
				weekday: "Friday",
				time: "17:00",
				timeZone: "Africa/Lagos",
				dayOfMonth: null,
				lastDay: false,
				effectiveFrom: "2026-11-01T23:00:00.000Z",
			});
			const audit = await q(
				`select action, summary from audit_logs where workspace_id = ${ws}`,
			);
			expect(audit.map((a) => a.action)).toContain("schedule.change");
		});
		it("is 403 for Staff and Head whatever the body, and changes nothing", async () => {
			for (const headers of [staff, head]) {
				for (const body of [weekly, { nonsense: true }]) {
					const res = await call(app, "PUT", `/workspaces/${ws}/schedule`, {
						headers,
						body,
					});
					expect(res.status).toBe(403);
					expect(res.error).toEqual({
						message: "You do not have permission to do this.",
					});
				}
			}
			expect(await count("workspace_schedules", ws)).toBe(0);
		});
		it("is 404 for a non-member", async () => {
			const stranger = await sessionFor((await createUser()).id);
			const res = await call(app, "PUT", `/workspaces/${ws}/schedule`, {
				headers: stranger,
				body: weekly,
			});
			expect(res.status).toBe(404);
			expect(res.error).toEqual({ message: "Workspace not found." });
		});
		it("gives a field error per bad field (AC3)", async () => {
			const cases: [Record<string, unknown>, string][] = [
				[{ ...weekly, time: "25:00" }, "time"],
				[{ ...weekly, timeZone: "Mars/Base" }, "timeZone"],
				[
					{ cadence: "weekly", time: "17:00", timeZone: "Africa/Lagos" },
					"weekday",
				],
				[
					{ cadence: "monthly", time: "17:00", timeZone: "Africa/Lagos" },
					"dayOfMonth",
				],
				[{ ...weekly, anchor_date: "2026-11-06" }, "anchor_date"],
				[{ ...weekly, cadence: "yearly" }, "cadence"],
			];
			for (const [body, field] of cases) {
				const res = await call(app, "PUT", `/workspaces/${ws}/schedule`, {
					headers: admin,
					body,
				});
				expect(res.status, field).toBe(400);
				expect(Object.keys(res.error), field).toContain(field);
			}
			expect(await count("workspace_schedules", ws)).toBe(0);
		});
		it("stores dayOfMonth null and lastDay false where the cadence does not use them", async () => {
			await call(app, "PUT", `/workspaces/${ws}/schedule`, {
				headers: admin,
				body: { ...weekly, dayOfMonth: 5, lastDay: true },
			});
			let [row] = await q(
				`select day_of_month, last_day from workspace_schedules where workspace_id = ${ws} and effective_from > '1971-01-01'`,
			);
			expect(row).toEqual({ day_of_month: null, last_day: false });
			await call(app, "PUT", `/workspaces/${ws}/schedule`, {
				headers: admin,
				body: {
					cadence: "monthly",
					time: "09:00",
					timeZone: "Africa/Lagos",
					dayOfMonth: 12,
					lastDay: true,
				},
			});
			[row] = await q(
				`select day_of_month, last_day from workspace_schedules where workspace_id = ${ws} and effective_from > '1971-01-01'`,
			);
			expect(row).toEqual({ day_of_month: null, last_day: true });
		});
		it("leaves stored periods alone and starts a stub at appliesFrom (AC4)", async () => {
			const before = await call(
				app,
				"GET",
				`/reporting-periods/current?workspaceId=${ws}`,
				{
					headers: staff,
				},
			);
			expect(before.data.label).toBe("Week of 26 October");
			const rowBefore = (
				await q(`select * from reporting_periods where id = ${before.data.id}`)
			)[0];
			await call(app, "PUT", `/workspaces/${ws}/schedule`, {
				headers: admin,
				body: weekly,
			});
			const same = await call(
				app,
				"GET",
				`/reporting-periods/current?workspaceId=${ws}`,
				{
					headers: staff,
				},
			);
			expect(same.data).toEqual(before.data);
			expect(
				(
					await q(
						`select * from reporting_periods where id = ${before.data.id}`,
					)
				)[0],
			).toEqual(rowBefore);
			setNow("2026-11-03T12:00:00Z");
			/* @info - Six days on, the first session has expired: sign in again at the new time. */
			staff = await sessionFor(team.staffUser.id);
			const stub = await call(
				app,
				"GET",
				`/reporting-periods/current?workspaceId=${ws}`,
				{
					headers: staff,
				},
			);
			/* @info - On 3 November the week of 26 October is due 2 November and closed for
			 * on-time, so the current period is the stub. */
			expect(stub.data).toMatchObject({
				label: "Week of 2 November",
				startsAt: "2026-11-01T23:00:00.000Z",
				endsAt: "2026-11-05T22:59:59.000Z",
				dueAt: "2026-11-06T16:00:00.000Z",
			});
			const sched = await call(app, "GET", `/workspaces/${ws}/schedule`, {
				headers: staff,
			});
			expect(sched.data.weekday).toBe("Friday");
			expect(sched.data.effectiveFrom).toBe("2026-11-01T23:00:00.000Z");
			expect(sched.data.pending).toBeNull();
		});
	});

	describe("E3 current and E4 open", () => {
		it("returns the E3 example shape at Monday 26 October 15:30 and at exactly 17:00:00.000 (AC7)", async () => {
			for (const t of [
				"2026-10-26T14:30:00.000Z",
				"2026-10-26T16:00:00.000Z",
			]) {
				setNow(t);
				const res = await call(
					app,
					"GET",
					`/reporting-periods/current?workspaceId=${ws}`,
					{
						headers: staff,
					},
				);
				expect(res.status).toBe(200);
				expect(res.data).toEqual({
					id: expect.stringMatching(/^[1-9][0-9]*$/),
					label: "Week of 19 October",
					startsAt: "2026-10-18T23:00:00.000Z",
					endsAt: "2026-10-25T22:59:59.000Z",
					dueAt: "2026-10-26T16:00:00.000Z",
				});
			}
			setNow("2026-10-26T16:00:00.001Z");
			const after = await call(
				app,
				"GET",
				`/reporting-periods/current?workspaceId=${ws}`,
				{
					headers: staff,
				},
			);
			expect(after.data.label).toBe("Week of 26 October");
		});
		it("stores one period for ten parallel requests (AC8)", async () => {
			const results = await Promise.all(
				Array.from({ length: 10 }, () =>
					call(app, "GET", `/reporting-periods/current?workspaceId=${ws}`, {
						headers: staff,
					}),
				),
			);
			expect(results.every((r) => r.status === 200)).toBe(true);
			expect(new Set(results.map((r) => r.data.id)).size).toBe(1);
			expect(await count("reporting_periods", ws)).toBe(1);
			expect(await count("workspace_schedules", ws)).toBe(1);
		});
		it("lists open periods oldest first, matching the E4 example (AC9)", async () => {
			const res = await call(
				app,
				"GET",
				`/reporting-periods/open?workspaceId=${ws}`,
				{
					headers: staff,
				},
			);
			expect(res.status).toBe(200);
			expect(
				res.data.map((p: Record<string, string>) => ({ ...p, id: undefined })),
			).toEqual([
				{
					id: undefined,
					label: "Week of 19 October",
					startsAt: "2026-10-18T23:00:00.000Z",
					endsAt: "2026-10-25T22:59:59.000Z",
					dueAt: "2026-10-26T16:00:00.000Z",
				},
				{
					id: undefined,
					label: "Week of 26 October",
					startsAt: "2026-10-25T23:00:00.000Z",
					endsAt: "2026-11-01T22:59:59.000Z",
					dueAt: "2026-11-02T16:00:00.000Z",
				},
			]);
		});
		it("does not open a period that ended before the Workspace was created (carry-over 3)", async () => {
			await q(
				`update workspaces set created_at = '2026-10-28T08:00:00Z' where id = ${ws}`,
			);
			const res = await call(
				app,
				"GET",
				`/reporting-periods/open?workspaceId=${ws}`,
				{
					headers: staff,
				},
			);
			expect(res.data.map((p: { label: string }) => p.label)).toEqual([
				"Week of 26 October",
			]);
			expect(await count("reporting_periods", ws)).toBe(1);
		});
		it("is 404 Not found for a non-member and a deactivated member, 400 for a bad id", async () => {
			const stranger = await sessionFor((await createUser()).id);
			await q(
				`update memberships set active = false where id = ${team.headM.id}`,
			);
			for (const headers of [stranger, head]) {
				for (const path of ["current", "open"]) {
					const res = await call(
						app,
						"GET",
						`/reporting-periods/${path}?workspaceId=${ws}`,
						{
							headers,
						},
					);
					expect(res.status).toBe(404);
					expect(res.error).toEqual({ message: "Not found." });
				}
			}
			for (const query of ["", "?workspaceId=2147483648", "?workspaceId=abc"]) {
				const res = await call(
					app,
					"GET",
					`/reporting-periods/current${query}`,
					{
						headers: staff,
					},
				);
				expect(res.status, query).toBe(400);
				expect(Object.keys(res.error)).toContain("workspaceId");
			}
			const res = await call(app, "GET", "/workspaces/2147483648/schedule", {
				headers: staff,
			});
			expect(res.status).toBe(400);
		});
		it("gives a suspended person 401 on E1 to E4", async () => {
			await q(
				`update users set suspended_at = now() where id = ${team.staffUser.id}`,
			);
			for (const [method, path] of [
				["GET", `/workspaces/${ws}/schedule`],
				["PUT", `/workspaces/${ws}/schedule`],
				["GET", `/reporting-periods/current?workspaceId=${ws}`],
				["GET", `/reporting-periods/open?workspaceId=${ws}`],
			] as const) {
				const res = await call(app, method, path, {
					headers: staff,
					body: method === "PUT" ? weekly : undefined,
				});
				expect(res.status, path).toBe(401);
			}
		});
	});

	describe("Workspace time zone owner (D26, AC29)", () => {
		it("keeps periods and the Schedule zone when the zone changes after a period exists", async () => {
			const before = await call(
				app,
				"GET",
				`/reporting-periods/current?workspaceId=${ws}`,
				{
					headers: staff,
				},
			);
			const patch = await call(app, "PATCH", `/workspaces/${ws}`, {
				headers: admin,
				body: { timeZone: "Africa/Cairo" },
			});
			expect(patch.status).toBe(200);
			const after = await call(
				app,
				"GET",
				`/reporting-periods/current?workspaceId=${ws}`,
				{
					headers: staff,
				},
			);
			expect(after.data).toEqual(before.data);
			const sched = await call(app, "GET", `/workspaces/${ws}/schedule`, {
				headers: staff,
			});
			expect(sched.data.timeZone).toBe("Africa/Lagos");
		});
		it("lets the default follow a zone corrected before any period exists (carry-over 1)", async () => {
			const patch = await call(app, "PATCH", `/workspaces/${ws}`, {
				headers: admin,
				body: { timeZone: "Africa/Cairo" },
			});
			expect(patch.status).toBe(200);
			expect(await count("workspace_schedules", ws)).toBe(0);
			const sched = await call(app, "GET", `/workspaces/${ws}/schedule`, {
				headers: staff,
			});
			expect(sched.data.timeZone).toBe("Africa/Cairo");
			const current = await call(
				app,
				"GET",
				`/reporting-periods/current?workspaceId=${ws}`,
				{
					headers: staff,
				},
			);
			/* @info - Week of 26 October in Cairo. Egypt keeps summer time (UTC+3) until the last
			 * Thursday of October (29 October 2026), so Monday 00:00 local is 25 October 21:00Z.
			 * Lagos would give 23:00Z: the start proves the new zone was used. */
			expect(current.data.startsAt).toBe("2026-10-25T21:00:00.000Z");
		});
		it("finishes a zone change racing ten current requests and a PUT with no 500 (D31)", async () => {
			const results = await Promise.all([
				call(app, "PATCH", `/workspaces/${ws}`, {
					headers: admin,
					body: { timeZone: "Africa/Cairo" },
				}),
				call(app, "PUT", `/workspaces/${ws}/schedule`, {
					headers: admin,
					body: weekly,
				}),
				...Array.from({ length: 10 }, () =>
					call(app, "GET", `/reporting-periods/current?workspaceId=${ws}`, {
						headers: staff,
					}),
				),
			]);
			expect(results.map((r) => r.status).filter((s) => s !== 200)).toEqual([]);
			expect(await count("reporting_periods", ws)).toBe(1);
		});
	});
});
