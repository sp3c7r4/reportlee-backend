/**
 * Shared set-up for the review suites (decisions, queue, comments, tasks, notifications): one
 * Workspace with an Admin, a Head and a Staff member, an open period, and request helpers.
 * Time is fixed with fake Date. Fake data only (@example.com).
 */
import "./auth";
import { sql } from "drizzle-orm";
import type { Hono } from "hono";
import { vi } from "vitest";
import { getDb } from "@/db/postgres.db";
import { buildApp, call } from "./app";
import { sessionFor } from "./auth";
import { resetTestDb, setupTestDb } from "./db";
import { addMember, createPeriod, createTeam, createUser } from "./factories";

/* @info - Wednesday 28 October 2026 12:00 Africa/Lagos. */
export const NOW = "2026-10-28T11:00:00.000Z";
export const CUR = {
	startsAt: "2026-10-25T23:00:00.000Z",
	endsAt: "2026-11-01T22:59:59.000Z",
	dueAt: "2026-11-02T16:00:00.000Z",
};
export const LONG = `<p>${"Met every partner on the list and closed five tickets."}</p>`;
export const MIN = 60_000;

export const q = async (text: string) =>
	(await getDb().execute(sql.raw(text))).rows as Record<string, any>[];

export interface ReviewEnv {
	app: Hono;
	team: Awaited<ReturnType<typeof createTeam>>;
	ws: number;
	periodId: number;
	/** @info - A second Staff member of the Space. */
	staff2: { userId: number; membershipId: number };
}

export const startApp = async (): Promise<Hono> => {
	await setupTestDb();
	return buildApp();
};

/** @info - Call in beforeEach, after vi.useFakeTimers. */
export const freshWorld = async (): Promise<Omit<ReviewEnv, "app">> => {
	vi.setSystemTime(new Date(NOW));
	await resetTestDb();
	const team = await createTeam();
	const ws = team.workspace.id;
	await q(
		`update workspaces set time_zone = 'Africa/Lagos', created_at = '2026-10-01T00:00:00Z' where id = ${ws}`,
	);
	const periodId = (
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
	return { team, ws, periodId, staff2: { userId: u.id, membershipId: m.id } };
};

export const requester =
	(app: Hono) =>
	async (userId: number, method: string, path: string, body?: unknown) =>
		call(app, method, path, { headers: await sessionFor(userId), body });

export type Req = ReturnType<typeof requester>;

/** @info - Saves and submits a report for `userId` in `periodId`. Returns its id. */
export const submitReport = async (
	req: Req,
	userId: number,
	periodId: number,
): Promise<string> => {
	const draft = await req(userId, "PATCH", "/reports/draft", {
		periodId: String(periodId),
		accomplishments: LONG,
	});
	if (draft.status !== 200) throw new Error(`draft failed: ${draft.status}`);
	const res = await req(userId, "POST", `/reports/${draft.data.id}/submit`);
	if (res.status !== 200) throw new Error(`submit failed: ${res.status}`);
	return res.data.id as string;
};
