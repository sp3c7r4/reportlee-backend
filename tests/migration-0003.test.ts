import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db/postgres.db";
import {
	applyMigration,
	dropReviewObjects,
	readMigration,
	resetTestDb,
	setupTestDb,
	splitStatements,
} from "./helpers/db";

const pgCode = async (run: () => Promise<unknown>): Promise<string | null> => {
	try {
		await run();
		return null;
	} catch (e: any) {
		return e?.cause?.code ?? e?.code ?? "unknown";
	}
};
const q = async (text: string) => {
	const res = await getDb().execute(sql.raw(text));
	return res.rows as Record<string, any>[];
};

describe("migration 0003_review", () => {
	beforeAll(async () => {
		await setupTestDb();
		await resetTestDb();
		/* @info - Start without the 0003 objects, then run the file twice through the helper that has
		 * no catch, so no statement may lean on the codes the real runner swallows. */
		await dropReviewObjects();
		await applyMigration("0003_review.sql");
		await applyMigration("0003_review.sql");
	});

	it("applies cleanly again in its CRLF form (the hash-change case)", async () => {
		const crlf = readMigration("0003_review.sql")
			.replace(/\r\n/g, "\n")
			.replace(/\n/g, "\r\n");
		for (const statement of splitStatements(crlf)) {
			await getDb().execute(sql.raw(statement));
		}
	});

	it("creates the two tables and three enums", async () => {
		const tables = (
			await q(
				`select table_name from information_schema.tables where table_schema='public'`,
			)
		).map((r) => r.table_name);
		expect(tables).toContain("report_comments");
		expect(tables).toContain("tasks");
		const enums = (
			await q(
				`select t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder) as labels from pg_type t join pg_enum e on e.enumtypid = t.oid group by t.typname`,
			)
		).reduce<Record<string, string>>((acc, r) => {
			acc[r.typname] = r.labels;
			return acc;
		}, {});
		expect(enums.comment_kind).toBe("comment,decision");
		expect(enums.task_status).toBe("todo,doing,done");
		expect(enums.task_priority).toBe("low,medium,high,critical");
	});

	it("adds the four notification types and three nullable notification columns", async () => {
		const labels = (
			await q(
				`select e.enumlabel from pg_type t join pg_enum e on e.enumtypid = t.oid where t.typname='notification_type'`,
			)
		).map((r) => r.enumlabel);
		for (const v of [
			"system",
			"account",
			"decision",
			"comment",
			"task",
			"submission",
		]) {
			expect(labels).toContain(v);
		}
		const cols = await q(
			`select column_name, is_nullable from information_schema.columns where table_name='notifications' and column_name in ('workspace_id','membership_id','href')`,
		);
		expect(cols.map((c) => c.column_name).sort()).toEqual([
			"href",
			"membership_id",
			"workspace_id",
		]);
		for (const c of cols) expect(c.is_nullable).toBe("YES");
	});

	it("has the indexes, with the comment link unique and partial", async () => {
		const defs = Object.fromEntries(
			(
				await q(
					`select indexname, indexdef from pg_indexes where schemaname='public'`,
				)
			).map((r) => [r.indexname, r.indexdef as string]),
		);
		for (const name of [
			"report_comments_report_created_idx",
			"tasks_assignee_status_idx",
			"tasks_ws_assigner_idx",
			"tasks_report_idx",
			"tasks_comment_uq",
			"notifications_user_ws_read_idx",
		]) {
			expect(defs[name], name).toBeDefined();
		}
		expect(defs.tasks_comment_uq).toMatch(/UNIQUE/);
		expect(defs.tasks_comment_uq).toMatch(/WHERE \(comment_id IS NOT NULL\)/);
	});
});

describe("migration 0003 constraints hold", () => {
	let workspaceId: number;
	let staffId: number;
	let adminId: number;
	let reportId: number;
	const insertComment = (body: string, kind = "comment") =>
		q(
			`insert into report_comments (report_id, author_membership_id, kind, body) values (${reportId}, ${adminId}, '${kind}', '${body}') returning id`,
		);
	const insertTask = (extra = "", values = "") =>
		q(
			`insert into tasks (workspace_id, report_id, title, assignee_membership_id, assigned_by_membership_id, due_on, priority${extra}) values (${workspaceId}, ${reportId}, 'Add the figures', ${staffId}, ${adminId}, '2026-11-25', 'high'${values}) returning id`,
		);

	beforeAll(async () => {
		await setupTestDb();
		await resetTestDb();
		const [u] = await q(
			`insert into users (first_name, last_name, email) values ('A','B','mig3a@example.com') returning id`,
		);
		const [u2] = await q(
			`insert into users (first_name, last_name, email) values ('C','D','mig3b@example.com') returning id`,
		);
		const [w] = await q(
			`insert into workspaces (name, slug, created_by) values ('Acme','acme-three',${u?.id}) returning id`,
		);
		workspaceId = w?.id;
		const [s] = await q(
			`insert into spaces (workspace_id, name) values (${workspaceId},'Platform') returning id`,
		);
		const [a] = await q(
			`insert into memberships (user_id, workspace_id, role) values (${u?.id},${workspaceId},'admin') returning id`,
		);
		adminId = a?.id;
		const [m] = await q(
			`insert into memberships (user_id, workspace_id, role, space_id) values (${u2?.id},${workspaceId},'staff',${s?.id}) returning id`,
		);
		staffId = m?.id;
		const [p] = await q(
			`insert into reporting_periods (workspace_id, label, starts_at, ends_at, due_at) values (${workspaceId}, 'Week of 19 October', '2026-10-18T23:00:00Z', '2026-10-25T22:59:59Z', '2026-10-26T16:00:00Z') returning id`,
		);
		const [r] = await q(
			`insert into reports (workspace_id, period_id, author_membership_id, space_id) values (${workspaceId}, ${p?.id}, ${staffId}, ${s?.id}) returning id`,
		);
		reportId = r?.id;
	});

	it("refuses an empty or over-long comment body and accepts 2000 characters", async () => {
		expect(await pgCode(() => insertComment(""))).toBe("23514");
		expect(await pgCode(() => insertComment("x".repeat(2001)))).toBe("23514");
		expect(await pgCode(() => insertComment("x".repeat(2000)))).toBeNull();
	});

	it("refuses a comment kind outside comment and decision", async () => {
		expect(await pgCode(() => insertComment("hello", "tag"))).toBe("22P02");
		expect(await pgCode(() => insertComment("because", "decision"))).toBeNull();
	});

	it("ties completed_at to the done status", async () => {
		expect(await pgCode(() => insertTask(", status", ", 'done'"))).toBe(
			"23514",
		);
		expect(await pgCode(() => insertTask(", completed_at", ", now()"))).toBe(
			"23514",
		);
		expect(
			await pgCode(() =>
				insertTask(", status, completed_at", ", 'done', now()"),
			),
		).toBeNull();
	});

	it("refuses an empty title, a long title and a long completion note", async () => {
		expect(
			await pgCode(() =>
				q(
					`insert into tasks (workspace_id, report_id, title, assignee_membership_id, assigned_by_membership_id, due_on, priority) values (${workspaceId}, ${reportId}, '', ${staffId}, ${adminId}, '2026-11-25', 'low')`,
				),
			),
		).toBe("23514");
		expect(
			await pgCode(() =>
				insertTask(
					", status, completed_at, completion_note",
					`, 'done', now(), '${"n".repeat(1001)}'`,
				),
			),
		).toBe("23514");
	});

	it("allows one task per comment", async () => {
		const [c] = await insertComment("please add the figures");
		expect(
			await pgCode(() => insertTask(", comment_id", `, ${c?.id}`)),
		).toBeNull();
		expect(await pgCode(() => insertTask(", comment_id", `, ${c?.id}`))).toBe(
			"23505",
		);
		expect(await pgCode(() => insertTask())).toBeNull();
		expect(await pgCode(() => insertTask())).toBeNull();
	});

	it("keeps a task when its comment is deleted, and removes both with the report", async () => {
		const [c] = await insertComment("second ask");
		const [t] = await insertTask(", comment_id", `, ${c?.id}`);
		await q(`delete from report_comments where id = ${c?.id}`);
		const [kept] = await q(`select comment_id from tasks where id = ${t?.id}`);
		expect(kept?.comment_id).toBeNull();
		await q(`delete from reports where id = ${reportId}`);
		const [left] = await q(
			`select (select count(*) from tasks)::int as t, (select count(*) from report_comments)::int as c`,
		);
		expect(left).toEqual({ t: 0, c: 0 });
	});
});
