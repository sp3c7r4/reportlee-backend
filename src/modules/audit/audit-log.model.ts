import { desc } from "drizzle-orm";
import {
	index,
	integer,
	pgTable,
	timestamp,
	varchar,
} from "drizzle-orm/pg-core";
import { TableNames } from "@/enums";
import { memberships } from "@/modules/membership/membership.model";
import { workspaces } from "@/modules/workspace/workspace.model";

/** @info - Append only: the repository exposes insert and list, never update or delete. */
export const audit_logs = pgTable(
	TableNames.AUDIT_LOGS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		workspaceId: integer("workspace_id")
			.notNull()
			.references(() => workspaces.id),
		actorMembershipId: integer("actor_membership_id").references(
			() => memberships.id,
			{ onDelete: "set null" },
		),
		action: varchar("action", { length: 64 }).notNull(),
		target: varchar("target", { length: 120 }).notNull(),
		/** @info - Ids and key names only. Never an email, a name or a token. */
		summary: varchar("summary", { length: 500 }).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("audit_logs_workspace_created_idx").on(
			table.workspaceId,
			desc(table.createdAt),
		),
	],
);

export type AuditLog = typeof audit_logs.$inferSelect;
export type NewAuditLog = typeof audit_logs.$inferInsert;
