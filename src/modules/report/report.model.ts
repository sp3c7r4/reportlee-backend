import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { TableNames } from "@/enums";
import { softDelete } from "@/models/soft-delete.model";
import { timestamps } from "@/models/timestamps.b.model";
import { memberships } from "@/modules/membership/membership.model";
import { reportingPeriods } from "@/modules/schedule/schedule.model";
import { spaces } from "@/modules/space/space.model";
import { workspaces } from "@/modules/workspace/workspace.model";

export const reportSubmissionStatus = pgEnum("report_submission_status", [
	"draft",
	"submitted",
	"late",
]);
export const reportReviewStatus = pgEnum("report_review_status", [
	"pending",
	"approved",
	"rejected",
]);
export const reportEventKind = pgEnum("report_event_kind", [
	"submitted",
	"edited",
	"seen",
	"approved",
	"rejected",
	"reopened",
]);
export type ReportEventKind = (typeof reportEventKind.enumValues)[number];

export interface ReportKpi {
	name: string;
	unit: string;
	value: number | null;
}
export interface ReportAttachment {
	name: string;
	size: number;
	type: string;
}
export interface ReportLocation {
	latitude: number;
	longitude: number;
	accuracy: number;
}

const instant = (name: string) =>
	timestamp(name, { withTimezone: true, mode: "date" });

/* @info - Mirrors src/db/migrations/0002_reports.sql. The SQL file is what runs. */
export const reports = pgTable(
	TableNames.REPORTS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		workspaceId: integer("workspace_id")
			.notNull()
			.references(() => workspaces.id),
		periodId: integer("period_id")
			.notNull()
			.references(() => reportingPeriods.id),
		authorMembershipId: integer("author_membership_id")
			.notNull()
			.references(() => memberships.id),
		spaceId: integer("space_id")
			.notNull()
			.references(() => spaces.id),
		accomplishments: text("accomplishments").default("").notNull(),
		challenges: text("challenges").default("").notNull(),
		plans: text("plans").default("").notNull(),
		kpis: jsonb("kpis").$type<ReportKpi[]>().default([]).notNull(),
		attachments: jsonb("attachments")
			.$type<ReportAttachment[]>()
			.default([])
			.notNull(),
		taggedMembershipIds: integer("tagged_membership_ids")
			.array()
			.default([])
			.notNull(),
		location: jsonb("location").$type<ReportLocation | null>(),
		submissionStatus: reportSubmissionStatus("submission_status")
			.default("draft")
			.notNull(),
		reviewStatus: reportReviewStatus("review_status")
			.default("pending")
			.notNull(),
		submittedAt: instant("submitted_at"),
		firstSeenAt: instant("first_seen_at"),
		windowStartedAt: instant("window_started_at"),
		editWindowMinutes: integer("edit_window_minutes").default(30).notNull(),
		...softDelete,
		...timestamps,
	},
	(table) => [
		uniqueIndex("reports_period_author_live_uq")
			.on(table.periodId, table.authorMembershipId)
			.where(sql`${table.deletedAt} IS NULL`),
		index("reports_ws_period_space_idx").on(
			table.workspaceId,
			table.periodId,
			table.spaceId,
		),
		index("reports_author_period_idx").on(
			table.authorMembershipId,
			table.periodId,
		),
		check(
			"reports_submitted_chk",
			sql`(${table.submissionStatus} = 'draft') = (${table.submittedAt} IS NULL)`,
		),
		check(
			"reports_edit_window_chk",
			sql`${table.editWindowMinutes} BETWEEN 1 AND 10080`,
		),
	],
);

export interface ReportContentSnapshot {
	accomplishments: string;
	challenges: string;
	plans: string;
	kpis: ReportKpi[];
	attachments: ReportAttachment[];
	taggedMembershipIds: number[];
	location: ReportLocation | null;
}

export const reportRevisions = pgTable(
	TableNames.REPORT_REVISIONS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		reportId: integer("report_id")
			.notNull()
			.references(() => reports.id, { onDelete: "cascade" }),
		previous: jsonb("previous").$type<ReportContentSnapshot>().notNull(),
		createdAt: instant("created_at").defaultNow().notNull(),
	},
	(table) => [index("report_revisions_report_idx").on(table.reportId)],
);

export const reportEvents = pgTable(
	TableNames.REPORT_EVENTS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		reportId: integer("report_id")
			.notNull()
			.references(() => reports.id, { onDelete: "cascade" }),
		kind: reportEventKind("kind").notNull(),
		actorMembershipId: integer("actor_membership_id")
			.notNull()
			.references(() => memberships.id, { onDelete: "restrict" }),
		createdAt: instant("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("report_events_report_created_idx").on(
			table.reportId,
			table.createdAt,
		),
	],
);

export type ReportRow = typeof reports.$inferSelect;
export type NewReportRow = typeof reports.$inferInsert;
