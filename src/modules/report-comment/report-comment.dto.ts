import type { CommentKind } from "./report-comment.model";
import type { CommentWithTask } from "./report-comment.repository";

/** @info - Mirrors `Comment` in the frontend's src/data/reports.ts. Ids are strings. */
export interface CommentDto {
	id: string;
	reportId: string;
	authorMembershipId: string;
	body: string;
	at: string;
	kind: CommentKind;
	taskId: string | null;
}

export const toCommentDto = (c: CommentWithTask): CommentDto => ({
	id: String(c.id),
	reportId: String(c.reportId),
	authorMembershipId: String(c.authorMembershipId),
	body: c.body,
	at: c.createdAt.toISOString(),
	kind: c.kind,
	taskId: c.taskId === null ? null : String(c.taskId),
});
