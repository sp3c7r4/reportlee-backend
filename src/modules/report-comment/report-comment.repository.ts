import { asc, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db/postgres.db";
import { tasks } from "@/modules/task/task.model";
import {
	type CommentKind,
	type ReportCommentRow,
	reportComments,
} from "./report-comment.model";

/** @info - Plain `(tx, ...)` functions, like report.repository.ts. Comments are append only. */

export const insertComment = async (
	tx: Tx,
	values: {
		reportId: number;
		authorMembershipId: number;
		kind: CommentKind;
		body: string;
		createdAt: Date;
	},
): Promise<ReportCommentRow> => {
	const [row] = await tx.insert(reportComments).values(values).returning();
	if (!row) throw new Error("comment insert returned no row");
	return row;
};

export type CommentWithTask = ReportCommentRow & { taskId: number | null };

/** @info - Batched: one query for every report on a page (no N+1). `taskId` is the task made from the comment, if any. */
export const commentsFor = async (
	tx: Tx,
	reportIds: number[],
): Promise<CommentWithTask[]> =>
	reportIds.length === 0
		? []
		: tx
				.select({
					id: reportComments.id,
					reportId: reportComments.reportId,
					authorMembershipId: reportComments.authorMembershipId,
					kind: reportComments.kind,
					body: reportComments.body,
					createdAt: reportComments.createdAt,
					taskId: tasks.id,
				})
				.from(reportComments)
				.leftJoin(tasks, eq(tasks.commentId, reportComments.id))
				.where(inArray(reportComments.reportId, reportIds))
				.orderBy(asc(reportComments.createdAt), asc(reportComments.id));
