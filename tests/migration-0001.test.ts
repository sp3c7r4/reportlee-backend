import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db/postgres.db";
import {
	applyMigration,
	dropSliceObjects,
	resetTestDb,
	setupTestDb,
} from "./helpers/db";

/** @info - Postgres error code from a drizzle error (the driver error sits in `cause`). */
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

describe("migration 0001_workspaces_people", () => {
	beforeAll(async () => {
		await setupTestDb();
		await resetTestDb();
		/* @info - Start from a slice-free database, then run the file twice. Any error fails the test: the
		 * helper has no catch, so even the five codes the real runner swallows (42710, 42P07,
		 * 42P16, 42701, 42704) fail here. */
		await dropSliceObjects();
		await applyMigration("0001_workspaces_people.sql");
		await applyMigration("0001_workspaces_people.sql");
	});

	it("creates the tables, enums and the users column", async () => {
		const tables = (
			await q(
				`select table_name from information_schema.tables where table_schema='public'`,
			)
		).map((r) => r.table_name);
		for (const t of [
			"workspaces",
			"spaces",
			"memberships",
			"invitations",
			"audit_logs",
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
		expect(enums.membership_role).toBe("staff,head,admin");
		expect(enums.invitation_status).toBe("pending,accepted,revoked,expired");
		expect(enums.workspace_plan).toBe("starter,team,enterprise");
		const cols = await q(
			`select is_nullable from information_schema.columns where table_name='users' and column_name='last_workspace_id'`,
		);
		expect(cols).toHaveLength(1);
		expect(cols[0]?.is_nullable).toBe("YES");
	});
});

describe("migration 0001 schema assertions (D28)", () => {
	beforeAll(async () => {
		await setupTestDb();
	});

	it("has every index in the SQL file", async () => {
		const names = (
			await q(`select indexname from pg_indexes where schemaname='public'`)
		).map((r) => r.indexname);
		for (const index of [
			"workspaces_slug_lower_uq",
			"spaces_workspace_name_lower_uq",
			"spaces_head_uq",
			"memberships_user_workspace_uq",
			"memberships_workspace_role_idx",
			"memberships_workspace_space_idx",
			"invitations_token_hash_uq",
			"invitations_pending_email_uq",
			"invitations_pending_head_uq",
			"invitations_workspace_status_idx",
			"audit_logs_workspace_created_idx",
		]) {
			expect(names, index).toContain(index);
		}
	});

	it("has every constraint in the SQL file", async () => {
		const names = (
			await q(
				`select conname from pg_constraint where connamespace = 'public'::regnamespace`,
			)
		).map((r) => r.conname);
		for (const c of [
			"workspaces_slug_format",
			"memberships_admin_space_chk",
			"invitations_email_lower_chk",
			"invitations_admin_space_chk",
			"spaces_head_membership_fk",
			"users_last_workspace_fk",
		]) {
			expect(names, c).toContain(c);
		}
	});

	it("makes the partial unique indexes partial", async () => {
		const defs = Object.fromEntries(
			(
				await q(
					`select indexname, indexdef from pg_indexes where schemaname='public'`,
				)
			).map((r) => [r.indexname, r.indexdef as string]),
		);
		expect(defs.spaces_head_uq).toMatch(/WHERE/i);
		expect(defs.invitations_pending_email_uq).toMatch(/pending/);
		expect(defs.invitations_pending_head_uq).toMatch(/head/);
		expect(defs.workspaces_slug_lower_uq).toMatch(/lower/);
	});
});

describe("migration 0001 constraints hold", () => {
	let userId: number;
	let workspaceId: number;
	let spaceId: number;

	beforeAll(async () => {
		await setupTestDb();
		await resetTestDb();
		const [u] = await q(
			`insert into users (first_name, last_name, email) values ('A','B','mig@example.com') returning id`,
		);
		userId = u?.id;
		const [w] = await q(
			`insert into workspaces (name, slug, created_by) values ('Acme','acme-ops',${userId}) returning id`,
		);
		workspaceId = w?.id;
		const [s] = await q(
			`insert into spaces (workspace_id, name) values (${workspaceId},'Platform') returning id`,
		);
		spaceId = s?.id;
	});

	it("refuses an Admin that has a Space (and a non-Admin without one)", async () => {
		expect(
			await pgCode(() =>
				q(
					`insert into memberships (user_id, workspace_id, role, space_id) values (${userId},${workspaceId},'admin',${spaceId})`,
				),
			),
		).toBe("23514");
		expect(
			await pgCode(() =>
				q(
					`insert into memberships (user_id, workspace_id, role) values (${userId},${workspaceId},'staff')`,
				),
			),
		).toBe("23514");
	});

	it("refuses a second Membership for the same person and Workspace", async () => {
		await q(
			`insert into memberships (user_id, workspace_id, role) values (${userId},${workspaceId},'admin')`,
		);
		expect(
			await pgCode(() =>
				q(
					`insert into memberships (user_id, workspace_id, role) values (${userId},${workspaceId},'admin')`,
				),
			),
		).toBe("23505");
	});

	it("refuses a duplicate slug, and malformed or upper case slugs", async () => {
		expect(
			await pgCode(() =>
				q(
					`insert into workspaces (name, slug, created_by) values ('Other','acme-ops',${userId})`,
				),
			),
		).toBe("23505");
		for (const slug of ["-ab", "ab-", "a--b", "ab", "UPPER", "has space"]) {
			expect(
				await pgCode(() =>
					q(
						`insert into workspaces (name, slug, created_by) values ('X','${slug}',${userId})`,
					),
				),
				slug,
			).toBe("23514");
		}
	});

	it("refuses an invitation email that is not lower case", async () => {
		const [m] = await q(
			`select id from memberships where user_id=${userId} limit 1`,
		);
		expect(
			await pgCode(() =>
				q(
					`insert into invitations (workspace_id,email,role,space_id,token_hash,invited_by_membership_id,expires_at) values (${workspaceId},'Mixed@Example.com','staff',${spaceId},'${"a".repeat(64)}',${m?.id},now())`,
				),
			),
		).toBe("23514");
	});
});
