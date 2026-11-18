import { sql } from "drizzle-orm";
import {
	boolean,
	char,
	check,
	date,
	index,
	integer,
	pgEnum,
	pgTable,
	smallint,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { TableNames } from "@/enums";
import { timestamps } from "@/models/timestamps.b.model";
import { memberships } from "@/modules/membership/membership.model";
import { workspaces } from "@/modules/workspace/workspace.model";

export const scheduleCadence = pgEnum("schedule_cadence", [
	"daily",
	"weekly",
	"fortnightly",
	"monthly",
	"quarterly",
]);
export type ScheduleCadence = (typeof scheduleCadence.enumValues)[number];

/* @info - Mirrors src/db/migrations/0002_reports.sql. The SQL file is what runs. */
export const workspaceSchedules = pgTable(
	TableNames.WORKSPACE_SCHEDULES,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		workspaceId: integer("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		cadence: scheduleCadence("cadence").notNull(),
		weekday: varchar("weekday", { length: 9 }),
		timeOfDay: char("time_of_day", { length: 5 }).notNull(),
		timeZone: varchar("time_zone", { length: 64 }).notNull(),
		dayOfMonth: smallint("day_of_month"),
		lastDay: boolean("last_day").default(false).notNull(),
		anchorDate: date("anchor_date", { mode: "string" }),
		effectiveFrom: timestamp("effective_from", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		createdByMembershipId: integer("created_by_membership_id").references(
			() => memberships.id,
			{ onDelete: "set null" },
		),
		...timestamps,
	},
	(table) => [
		uniqueIndex("workspace_schedules_ws_effective_uq").on(
			table.workspaceId,
			table.effectiveFrom,
		),
		check(
			"workspace_schedules_time_chk",
			sql`${table.timeOfDay} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
		),
	],
);

export const reportingPeriods = pgTable(
	TableNames.REPORTING_PERIODS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		workspaceId: integer("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		label: varchar("label", { length: 80 }).notNull(),
		startsAt: timestamp("starts_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		endsAt: timestamp("ends_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		dueAt: timestamp("due_at", { withTimezone: true, mode: "date" }).notNull(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("reporting_periods_ws_start_uq").on(
			table.workspaceId,
			table.startsAt,
		),
		index("reporting_periods_ws_due_idx").on(table.workspaceId, table.dueAt),
	],
);

export type WorkspaceScheduleRow = typeof workspaceSchedules.$inferSelect;
export type ReportingPeriodRow = typeof reportingPeriods.$inferSelect;
