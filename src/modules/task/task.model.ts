import { sql } from "drizzle-orm";
import {
	check,
	date,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { TableNames } from "@/enums";
import { memberships } from "@/modules/membership/membership.model";
import { reports } from "@/modules/report/report.model";
import { reportComments } from "@/modules/report-comment/report-comment.model";
import { workspaces } from "@/modules/workspace/workspace.model";

export const taskStatus = pgEnum("task_status", ["todo", "doing", "done"]);
export const taskPriority = pgEnum("task_priority", [
	"low",
	"medium",
	"high",
	"critical",
]);
export type TaskStatus = (typeof taskStatus.enumValues)[number];
export type TaskPriority = (typeof taskPriority.enumValues)[number];

export interface TaskCompletionFile {
	name: string;
	size: number;
	type: string;
}

const instant = (name: string) =>
	timestamp(name, { withTimezone: true, mode: "date" });

/* @info - Mirrors src/db/migrations/0003_review.sql. The SQL file is what runs. */
export const tasks = pgTable(
	TableNames.TASKS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		workspaceId: integer("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		reportId: integer("report_id")
			.notNull()
			.references(() => reports.id, { onDelete: "cascade" }),
		commentId: integer("comment_id").references(() => reportComments.id, {
			onDelete: "set null",
		}),
		title: varchar("title", { length: 200 }).notNull(),
		assigneeMembershipId: integer("assignee_membership_id")
			.notNull()
			.references(() => memberships.id, { onDelete: "restrict" }),
		assignedByMembershipId: integer("assigned_by_membership_id")
			.notNull()
			.references(() => memberships.id, { onDelete: "restrict" }),
		dueOn: date("due_on").notNull(),
		status: taskStatus("status").default("todo").notNull(),
		priority: taskPriority("priority").notNull(),
		completionNote: text("completion_note"),
		completionFile: jsonb("completion_file").$type<TaskCompletionFile | null>(),
		completedAt: instant("completed_at"),
		createdAt: instant("created_at").defaultNow().notNull(),
		updatedAt: instant("updated_at")
			.defaultNow()
			.notNull()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		index("tasks_assignee_status_idx").on(
			table.assigneeMembershipId,
			table.status,
		),
		index("tasks_ws_assigner_idx").on(
			table.workspaceId,
			table.assignedByMembershipId,
		),
		index("tasks_report_idx").on(table.reportId),
		uniqueIndex("tasks_comment_uq")
			.on(table.commentId)
			.where(sql`${table.commentId} IS NOT NULL`),
		check(
			"tasks_title_chk",
			sql`char_length(${table.title}) BETWEEN 1 AND 200`,
		),
		check(
			"tasks_note_chk",
			sql`${table.completionNote} IS NULL OR char_length(${table.completionNote}) <= 1000`,
		),
		check(
			"tasks_done_chk",
			sql`(${table.status} = 'done') = (${table.completedAt} IS NOT NULL)`,
		),
	],
);

export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
