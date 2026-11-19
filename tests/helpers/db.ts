/**
 * Real-Postgres test helper (workspaces-people, D18).
 *
 * The pool in src/db/postgres.db.ts is built from `config.db.uri` (POSTGRES_URI) when that module
 * is first imported, so the database cannot be chosen from here. It comes from `.env.test`
 * (POSTGRES_URI, set by name only here, never printed) or the shell. This helper refuses to run
 * unless the host is localhost or 127.0.0.1 and the database name ends in `_test`, because it
 * truncates tables between tests. It prints the database name only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { config } from "@/config";
import { connectPostgresDB, getDb } from "@/db/postgres.db";

/* @info - Copy of the split in app/migrate.ts (a top-level script with no exports). */
export const splitStatements = (text: string): string[] =>
	text
		.split("--> statement-breakpoint")
		.map((s) => s.trim())
		.filter(Boolean);

const migrationsDir = join(__dirname, "..", "..", "src", "db", "migrations");

export const readMigration = (file: string): string =>
	readFileSync(join(migrationsDir, file), "utf-8");

/** @info - Throws unless POSTGRES_URI is a local database whose name ends in `_test`. */
export const assertLocalTestDb = (): string => {
	const url = new URL(config.db.uri);
	const name = url.pathname.replace(/^\//, "");
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	if (!local || !name.endsWith("_test")) {
		throw new Error(
			"Refusing to run: POSTGRES_URI must point at localhost and a database whose name ends in _test.",
		);
	}
	return name;
};

/** @info - Applies one migration file. No catch: any error fails the test (D28). */
export const applyMigration = async (file: string) => {
	for (const statement of splitStatements(readMigration(file))) {
		await getDb().execute(sql.raw(statement));
	}
};

const SLICE_TABLES = [
	"tasks",
	"report_comments",
	"report_events",
	"report_revisions",
	"reports",
	"reporting_periods",
	"workspace_schedules",
	"audit_logs",
	"invitations",
	"memberships",
	"spaces",
	"workspaces",
] as const;

/** @info - Connects, checks the database is a local test one, builds the schema when empty. */
export const setupTestDb = async () => {
	const name = assertLocalTestDb();
	await connectPostgresDB(() => {});
	console.info(`[test-db] using database ${name}`);
	const [row] = (
		await getDb().execute(
			sql`select to_regclass('public.users') is not null as present`,
		)
	).rows as { present: boolean }[];
	if (!row?.present) await applyMigration("0000_clear_rage.sql");
	await applyMigration("0001_workspaces_people.sql");
	await applyMigration("0002_reports.sql");
	await applyMigration("0003_review.sql");
};

/** @info - Empties every table a slice test touches. Safe: the database is a `_test` one. */
export const resetTestDb = async () => {
	assertLocalTestDb();
	await getDb().execute(
		sql.raw(
			`TRUNCATE TABLE ${[...SLICE_TABLES, "user_roles", "notifications", "users"].map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
		),
	);
};

/** @info - Drops the tables, columns and types 0003 created. The four notification_type values
 * stay: Postgres cannot drop an enum value, and 0003 uses ADD VALUE IF NOT EXISTS. */
export const dropReviewObjects = async () => {
	assertLocalTestDb();
	await getDb().execute(
		sql.raw(
			`DROP TABLE IF EXISTS "tasks", "report_comments" CASCADE; DROP INDEX IF EXISTS "notifications_user_ws_read_idx"; ALTER TABLE IF EXISTS "notifications" DROP CONSTRAINT IF EXISTS "notifications_workspace_fk"; ALTER TABLE IF EXISTS "notifications" DROP CONSTRAINT IF EXISTS "notifications_membership_fk"; ALTER TABLE IF EXISTS "notifications" DROP COLUMN IF EXISTS "workspace_id", DROP COLUMN IF EXISTS "membership_id", DROP COLUMN IF EXISTS "href"; DROP TYPE IF EXISTS "comment_kind", "task_status", "task_priority" CASCADE`,
		),
	);
};

/** @info - Drops what 0002 created, so a test can run it on a database that only has 0001. */
export const dropReportObjects = async () => {
	assertLocalTestDb();
	await dropReviewObjects();
	await getDb().execute(
		sql.raw(
			`DROP TABLE IF EXISTS "report_events", "report_revisions", "reports", "reporting_periods", "workspace_schedules" CASCADE; ALTER TABLE IF EXISTS "workspaces" DROP CONSTRAINT IF EXISTS "workspaces_edit_window_chk"; ALTER TABLE IF EXISTS "workspaces" DROP COLUMN IF EXISTS "edit_window_minutes"; DROP TYPE IF EXISTS "schedule_cadence", "report_submission_status", "report_review_status", "report_event_kind" CASCADE`,
		),
	);
};
/** @info - Drops what 0001 (and 0002, which depends on it) created, so a test can run it on an empty slice. */
export const dropSliceObjects = async () => {
	await dropReportObjects();
	await getDb().execute(
		sql.raw(
			`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_last_workspace_fk"; ALTER TABLE "users" DROP COLUMN IF EXISTS "last_workspace_id"; DROP TABLE IF EXISTS "audit_logs", "invitations", "memberships", "spaces", "workspaces" CASCADE; DROP TYPE IF EXISTS "membership_role", "invitation_status", "workspace_plan" CASCADE`,
		),
	);
};
