import { sql } from "drizzle-orm";
import {
	integer,
	jsonb,
	pgTable,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { TableNames } from "@/enums";
import { timestamps } from "@/models/timestamps.b.model";
import { workspaces } from "@/modules/workspace/workspace.model";

export interface KpiTemplateRow {
	name: string;
	unit: string;
}

export const spaces = pgTable(
	TableNames.SPACES,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		workspaceId: integer("workspace_id")
			.notNull()
			.references(() => workspaces.id),
		name: varchar("name", { length: 80 }).notNull(),
		/** @info - The foreign key to memberships is added in SQL only. A reference here would
		 * make spaces and memberships import each other. */
		headMembershipId: integer("head_membership_id"),
		kpiTemplate: jsonb("kpi_template")
			.$type<KpiTemplateRow[]>()
			.default([])
			.notNull(),
		archivedAt: timestamp("archived_at"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("spaces_workspace_name_lower_uq").on(
			table.workspaceId,
			sql`lower(${table.name})`,
		),
		uniqueIndex("spaces_head_uq")
			.on(table.headMembershipId)
			.where(sql`${table.headMembershipId} IS NOT NULL`),
	],
);

export type Space = typeof spaces.$inferSelect;
export type NewSpace = typeof spaces.$inferInsert;
