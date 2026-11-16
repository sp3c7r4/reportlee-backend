import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	integer,
	pgEnum,
	pgTable,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { TableNames } from "@/enums";
import { softDelete } from "@/models/soft-delete.model";
import { timestamps } from "@/models/timestamps.b.model";
import { users } from "@/modules/user/user.model";

export const workspacePlan = pgEnum("workspace_plan", [
	"starter",
	"team",
	"enterprise",
]);

/* @info - Mirrors src/db/migrations/0001_workspaces_people.sql. The SQL file is what runs. */
export const workspaces = pgTable(
	TableNames.WORKSPACES,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		name: varchar("name", { length: 120 }).notNull(),
		slug: varchar("slug", { length: 32 }).notNull(),
		plan: workspacePlan("plan").default("starter").notNull(),
		/** @info - null means no limit. */
		memberLimit: integer("member_limit").default(10),
		aiFeatures: boolean("ai_features").default(false).notNull(),
		timeZone: varchar("time_zone", { length: 64 }).default("UTC").notNull(),
		locationTagging: boolean("location_tagging").default(false).notNull(),
		readOnly: boolean("read_only").default(false).notNull(),
		createdBy: integer("created_by")
			.notNull()
			.references(() => users.id),
		...softDelete,
		...timestamps,
	},
	(table) => [
		uniqueIndex("workspaces_slug_lower_uq").on(sql`lower(${table.slug})`),
		check(
			"workspaces_slug_format",
			sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(${table.slug}) BETWEEN 3 AND 32`,
		),
	],
);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
