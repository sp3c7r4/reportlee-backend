import { and, eq, inArray } from "drizzle-orm";
import { getDb, type Tx } from "@/db/postgres.db";
import { CodedForbiddenError, FieldError } from "@/errors";
import { AuditLogService } from "@/modules/audit/audit-log.service";
import { isActiveMember } from "@/modules/membership/active";
import { memberships } from "@/modules/membership/membership.model";
import { markSeen } from "@/modules/report/report.repository";
import { ReportAccess } from "@/modules/report/report-access";
import { insertTask } from "@/modules/task/task.repository";
import { users } from "@/modules/user/user.model";
import { plainText } from "./comment-sanitizer";
import { type CommentDto, toCommentDto } from "./report-comment.dto";
import {
	BODY_MAX,
	COMMENT_CODES,
	COMMENT_MESSAGES,
	TITLE_MAX,
} from "./report-comment.message";
import { insertComment } from "./report-comment.repository";
import type { CommentBody } from "./report-comment.schema";

/** @info - D15: an active Staff or Head Membership of the Workspace. Admins author nothing. */
const isAssignable = async (
	tx: Tx,
	workspaceId: number,
	membershipId: number,
): Promise<boolean> => {
	const [row] = await tx
		.select({ id: memberships.id })
		.from(memberships)
		.innerJoin(users, eq(users.id, memberships.userId))
		.where(
			and(
				eq(memberships.id, membershipId),
				eq(memberships.workspaceId, workspaceId),
				inArray(memberships.role, ["staff", "head"]),
				isActiveMember(),
			),
		)
		.limit(1);
	return Boolean(row);
};

export interface CommentResult {
	comment: CommentDto;
	reportId: number;
	workspaceId: number;
	authorMembershipId: number;
	callerMembershipId: number;
	byReviewer: boolean;
	task: { id: number; assigneeMembershipId: number } | null;
}

export class ReportCommentService {
	private static instance: ReportCommentService;
	private readonly access = ReportAccess.getInstance();
	private readonly audit = AuditLogService.getInstance();
	static getInstance() {
		if (!this.instance) this.instance = new ReportCommentService();
		return this.instance;
	}
	private constructor() {}

	/**
	 * @info - E14. Comment and task are one transaction (no orphan task). A reviewer's comment
	 * counts as a look (D12), so the author can no longer delete a report with live comments. Text
	 * is sanitized before any length rule (D13).
	 */
	add = async (
		userId: number,
		reportId: number,
		body: CommentBody,
		now: Date,
	): Promise<CommentResult> =>
		getDb().transaction(async (tx) => {
			const { report, caller, relation } = await this.access.assertComment(
				tx,
				userId,
				reportId,
			);
			const text = plainText(body.body);
			if (text.length < 1 || text.length > BODY_MAX) {
				throw new FieldError({ body: COMMENT_MESSAGES.BODY_REQUIRED });
			}
			let title: string | null = null;
			if (body.followUp) {
				if (relation !== "reviewer") {
					throw new CodedForbiddenError(
						COMMENT_MESSAGES.REVIEWER_MUST_START,
						COMMENT_CODES.REVIEWER_MUST_START,
					);
				}
				title = plainText(body.followUp.title);
				if (title.length < 1 || title.length > TITLE_MAX) {
					throw new FieldError({
						"followUp.title": COMMENT_MESSAGES.TITLE_REQUIRED,
					});
				}
				const assignee = Number(body.followUp.assigneeMembershipId);
				if (
					assignee === caller.membershipId ||
					!(await isAssignable(tx, caller.workspaceId, assignee))
				) {
					throw new FieldError({
						"followUp.assigneeMembershipId": COMMENT_MESSAGES.ASSIGNEE,
					});
				}
			}
			const current =
				relation === "reviewer"
					? await markSeen(tx, report, caller.membershipId, now, {
							startWindow: true,
							event: "first",
						})
					: report;
			const comment = await insertComment(tx, {
				reportId: current.id,
				authorMembershipId: caller.membershipId,
				kind: "comment",
				body: text,
				createdAt: now,
			});
			let task: CommentResult["task"] = null;
			if (body.followUp && title !== null) {
				const row = await insertTask(tx, {
					workspaceId: caller.workspaceId,
					reportId: current.id,
					commentId: comment.id,
					title,
					assigneeMembershipId: Number(body.followUp.assigneeMembershipId),
					assignedByMembershipId: caller.membershipId,
					dueOn: body.followUp.dueAt,
					priority: body.followUp.priority,
					createdAt: now,
					updatedAt: now,
				});
				task = { id: row.id, assigneeMembershipId: row.assigneeMembershipId };
				await this.audit.record(tx, {
					workspaceId: caller.workspaceId,
					actorMembershipId: caller.membershipId,
					action: "task.created",
					target: `task:${row.id}`,
					summary: `Task ${row.id} on report ${current.id} for membership ${row.assigneeMembershipId}`,
				});
			}
			return {
				comment: toCommentDto({ ...comment, taskId: task?.id ?? null }),
				reportId: current.id,
				workspaceId: caller.workspaceId,
				authorMembershipId: current.authorMembershipId,
				callerMembershipId: caller.membershipId,
				byReviewer: relation === "reviewer",
				task,
			};
		});
}
