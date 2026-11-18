import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db/postgres.db";
import {
	applyMigration,
	dropReportObjects,
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

describe("migration 0002_reports", () => {
	beforeAll(async () => {
		await setupTestDb();
		await resetTestDb();
		/* @info - Start without the 0002 objects, then run the file twice through the helper that has
		 * no catch, so no statement may lean on the codes the real runner swallows. */
		await dropReportObjects();
		await applyMigration("0002_reports.sql");
		await applyMigration("0002_reports.sql");
	});

	/* @info - core.autocrlf=true can check the file out as CRLF, which changes its hash, so the
	 * runner applies it once more. That is safe only if the CRLF text also runs cleanly over an
	 * applied schema. */
	it("applies cleanly again in its CRLF form (the hash-change case)", async () => {
		const crlf = readMigration("0002_reports.sql")
			.replace(/\r\n/g, "\n")
			.replace(/\n/g, "\r\n");
		for (const statement of splitStatements(crlf)) {
			await getDb().execute(sql.raw(statement));
		}
	});

	it("creates the five tables and four enums", async () => {
		const tables = (
			await q(
				`select table_name from information_schema.tables where table_schema='public'`,
			)
		).map((r) => r.table_name);
		for (const t of [
			"workspace_schedules",
			"reporting_periods",
			"reports",
			"report_revisions",
			"report_events",
		]) {
			expect(tables).toContain(t);
		}
		const enums = (
			await q(
				`select t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder) as labels from pg_type t join pg_enum e on e.enumtypid = t.oid group by t.typname`,
			)
		).reduce<Record<string, string>>((acc, r) => {
			acc[r.typname] = r.labels;
			return acc;
		}, {});
		expect(enums.schedule_cadence).toBe(
			"daily,weekly,fortnightly,monthly,quarterly",
		);
		expect(enums.report_submission_status).toBe("draft,submitted,late");
		expect(enums.report_review_status).toBe("pending,approved,rejected");
		expect(enums.report_event_kind).toBe(
			"submitted,edited,seen,approved,rejected,reopened",
		);
	});

	it("adds workspaces.edit_window_minutes, not null with default 30", async () => {
		const [col] = await q(
			`select is_nullable, column_default from information_schema.columns where table_name='workspaces' and column_name='edit_window_minutes'`,
		);
		expect(col?.is_nullable).toBe("NO");
		expect(String(col?.column_default)).toBe("30");
	});

	it("has the indexes, with the live-draft index partial on deleted_at", async () => {
		const defs = Object.fromEntries(
			(
				await q(
					`select indexname, indexdef from pg_indexes where schemaname='public'`,
				)
			).map((r) => [r.indexname, r.indexdef as string]),
		);
		for (const name of [
			"workspace_schedules_ws_effective_uq",
			"reporting_periods_ws_start_uq",
			"reporting_periods_ws_due_idx",
			"reports_period_author_live_uq",
			"reports_ws_period_space_idx",
			"reports_author_period_idx",
			"report_revisions_report_idx",
			"report_events_report_created_idx",
		]) {
			expect(defs[name], name).toBeDefined();
		}
		expect(defs.reports_period_author_live_uq).toMatch(/UNIQUE/);
		expect(defs.reports_period_author_live_uq).toMatch(
			/WHERE \(deleted_at IS NULL\)/,
		);
	});
});

describe("migration 0002 constraints hold", () => {
	let workspaceId: number;
	let spaceId: number;
	let staffId: number;
	let periodId: number;
	const insertReport = (extra = "", values = "") =>
		q(
			`insert into reports (workspace_id, period_id, author_membership_id, space_id${extra}) values (${workspaceId}, ${periodId}, ${staffId}, ${spaceId}${values}) returning id`,
		);

	beforeAll(async () => {
		await setupTestDb();
		await resetTestDb();
		const [u] = await q(
			`insert into users (first_name, last_name, email) values ('A','B','mig2@example.com') returning id`,
		);
		const [w] = await q(
			`insert into workspaces (name, slug, created_by) values ('Acme','acme-two',${u?.id}) returning id`,
		);
		workspaceId = w?.id;
		const [s] = await q(
			`insert into spaces (workspace_id, name) values (${workspaceId},'Platform') returning id`,
		);
		spaceId = s?.id;
		const [m] = await q(
			`insert into memberships (user_id, workspace_id, role, space_id) values (${u?.id},${workspaceId},'staff',${spaceId}) returning id`,
		);
		staffId = m?.id;
		const [p] = await q(
			`insert into reporting_periods (workspace_id, label, starts_at, ends_at, due_at) values (${workspaceId}, 'Week of 19 October', '2026-10-18T23:00:00Z', '2026-10-25T22:59:59Z', '2026-10-26T16:00:00Z') returning id`,
		);
		periodId = p?.id;
	});

	it("allows one live report per person per period, and a soft delete frees the slot", async () => {
		const [first] = await insertReport();
		expect(await pgCode(() => insertReport())).toBe("23505");
		await q(`update reports set deleted_at = now() where id = ${first?.id}`);
		expect(await pgCode(() => insertReport())).toBeNull();
	});

	it("ties submitted_at to the submission status", async () => {
		await q(`update reports set deleted_at = now() where deleted_at is null`);
		expect(
			await pgCode(() => insertReport(", submission_status", ", 'submitted'")),
		).toBe("23514");
		expect(await pgCode(() => insertReport(", submitted_at", ", now()"))).toBe(
			"23514",
		);
	});

	it("refuses an edit window outside 1 to 10080 on reports and workspaces", async () => {
		await q(`update reports set deleted_at = now() where deleted_at is null`);
		expect(
			await pgCode(() => insertReport(", edit_window_minutes", ", 0")),
		).toBe("23514");
		expect(
			await pgCode(() =>
				q(
					`update workspaces set edit_window_minutes = 10081 where id = ${workspaceId}`,
				),
			),
		).toBe("23514");
	});

	it("refuses a period whose start, end and due are out of order, and a second period with the same start", async () => {
		expect(
			await pgCode(() =>
				q(
					`insert into reporting_periods (workspace_id, label, starts_at, ends_at, due_at) values (${workspaceId}, 'x', '2026-11-02T00:00:00Z', '2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z')`,
				),
			),
		).toBe("23514");
		expect(
			await pgCode(() =>
				q(
					`insert into reporting_periods (workspace_id, label, starts_at, ends_at, due_at) values (${workspaceId}, 'x', '2026-10-18T23:00:00Z', '2026-10-25T22:59:59Z', '2026-10-26T16:00:00Z')`,
				),
			),
		).toBe("23505");
	});

	it("refuses schedules that break the cadence rules", async () => {
		const ins = (cols: string, vals: string) =>
			q(
				`insert into workspace_schedules (workspace_id, time_zone, effective_from, cadence, time_of_day${cols}) values (${workspaceId}, 'Africa/Lagos', now() + interval '${Math.floor(Math.random() * 100000)} seconds', ${vals})`,
			);
		expect(await pgCode(() => ins("", "'weekly', '17:00'"))).toBe("23514");
		expect(
			await pgCode(() => ins(", weekday", "'fortnightly', '17:00', 'Monday'")),
		).toBe("23514");
		expect(await pgCode(() => ins("", "'monthly', '17:00'"))).toBe("23514");
		expect(
			await pgCode(() => ins(", weekday", "'weekly', '24:00', 'Monday'")),
		).toBe("23514");
		expect(
			await pgCode(() => ins(", day_of_month", "'monthly', '17:00', 32")),
		).toBe("23514");
		expect(
			await pgCode(() => ins(", weekday", "'weekly', '17:00', 'Monday'")),
		).toBeNull();
		expect(
			await pgCode(() => ins(", last_day", "'quarterly', '09:30', true")),
		).toBeNull();
	});
});
