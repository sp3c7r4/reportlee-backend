import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { TableNames } from "@/enums";
import { memberships } from "@/modules/membership/membership.model";
import { reports } from "@/modules/report/report.model";

export const commentKind = pgEnum("comment_kind", ["comment", "decision"]);
export type CommentKind = (typeof commentKind.enumValues)[number];

/* @info - Mirrors src/db/migrations/0003_review.sql. The SQL file is what runs. Rows are append
 * only: v1 has no edit or delete. Bodies are plain text, sanitized before the insert. */
export const reportComments = pgTable(
	TableNames.REPORT_COMMENTS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		reportId: integer("report_id")
			.notNull()
			.references(() => reports.id, { onDelete: "cascade" }),
		authorMembershipId: integer("author_membership_id")
			.notNull()
			.references(() => memberships.id, { onDelete: "restrict" }),
		kind: commentKind("kind").default("comment").notNull(),
		body: text("body").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("report_comments_report_created_idx").on(
			table.reportId,
			table.createdAt,
		),
		check(
			"report_comments_body_chk",
			sql`char_length(${table.body}) BETWEEN 1 AND 2000`,
		),
	],
);

export type ReportCommentRow = typeof reportComments.$inferSelect;
export type NewReportCommentRow = typeof reportComments.$inferInsert;
