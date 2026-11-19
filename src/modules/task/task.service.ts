import { and, eq } from "drizzle-orm";
import { getDb, getReader, type Tx } from "@/db/postgres.db";
import { CodedForbiddenError, FieldError } from "@/errors";
import { AuditLogService } from "@/modules/audit/audit-log.service";
import { memberships } from "@/modules/membership/membership.model";
import type { Caller } from "@/modules/membership/membership.service";
import { notFound, resolveOrNotFound } from "@/modules/report/scope";
import { plainText } from "@/modules/report-comment/comment-sanitizer";
import { headedSpaceIds } from "@/modules/review/review.repository";
import { type TaskDto, toTaskDto } from "./task.dto";
import { NOTE_MAX, TASK_CODES, TASK_MESSAGES } from "./task.message";
import {
	listTasks,
	lockTask,
	reportIsLive,
	taskWho,
	updateTask,
} from "./task.repository";
import type { MoveBody, TaskListQuery, TaskView } from "./task.schema";

/** @info - V6, mirrors `viewsFor` in the frontend's src/lib/tasks.ts. */
export const VIEWS_FOR: Record<Caller["role"], readonly TaskView[]> = {
	staff: ["mine"],
	head: ["mine", "by", "space"],
	admin: ["by", "all"],
};

/** @info - Active and inactive Memberships of the Spaces a Head leads: `space` shows their tasks. */
const membersOfSpaces = async (
	tx: Tx,
	workspaceId: number,
	spaceIds: number[],
) => {
	const out: number[] = [];
	for (const spaceId of spaceIds) {
		const rows = await tx
			.select({ id: memberships.id })
			.from(memberships)
			.where(
				and(
					eq(memberships.workspaceId, workspaceId),
					eq(memberships.spaceId, spaceId),
				),
			);
		out.push(...rows.map((r) => r.id));
	}
	return out;
};

export class TaskService {
	private static instance: TaskService;
	private readonly audit = AuditLogService.getInstance();
	static getInstance() {
		if (!this.instance) this.instance = new TaskService();
		return this.instance;
	}
	private constructor() {}

	/**
	 * @info - E17. `mine`: assignee is the caller. `by`: assigner is the caller. `space`: the
	 * assignee is in a Space the caller is Head of. `all`: every task of the Workspace.
	 */
	list = async (
		userId: number,
		query: TaskListQuery,
		now: Date,
	): Promise<TaskDto[]> => {
		const caller = await resolveOrNotFound(userId, Number(query.workspaceId));
		if (!VIEWS_FOR[caller.role].includes(query.view)) {
			throw new CodedForbiddenError(
				TASK_MESSAGES.VIEW_NOT_ALLOWED,
				TASK_CODES.VIEW_NOT_ALLOWED,
			);
		}
		const db = getReader();
		let who: ReturnType<typeof taskWho.assignee> | undefined;
		if (query.view === "mine") who = taskWho.assignee(caller.membershipId);
		if (query.view === "by") who = taskWho.assigner(caller.membershipId);
		if (query.view === "space") {
			const spaces = await headedSpaceIds(db, caller.membershipId);
			const ids = await membersOfSpaces(db, caller.workspaceId, spaces);
			if (ids.length === 0) return [];
			who = taskWho.assigneesIn(ids);
		}
		const rows = await listTasks(db, {
			workspaceId: caller.workspaceId,
			who,
			now,
		});
		return rows.map(toTaskDto);
	};

	/**
	 * @info - E18. The one rule: only the assignee moves a task. Allowed in a read-only Workspace
	 * (D21). Done sets `completed_at`, the note and the file; any other status clears all three.
	 */
	move = async (
		userId: number,
		taskId: number,
		body: MoveBody,
		now: Date,
	): Promise<TaskDto> =>
		getDb().transaction(async (tx) => {
			const task = await lockTask(tx, taskId);
			if (!task) return notFound();
			const caller = await resolveOrNotFound(userId, task.workspaceId);
			if (!(await reportIsLive(tx, task.reportId))) return notFound();
			if (task.assigneeMembershipId !== caller.membershipId) {
				throw new CodedForbiddenError(
					TASK_MESSAGES.NOT_ASSIGNEE,
					TASK_CODES.NOT_ASSIGNEE,
				);
			}
			let note: string | null = null;
			if (body.status === "done" && body.completionNote !== undefined) {
				note = plainText(body.completionNote);
				if (note.length > NOTE_MAX) {
					throw new FieldError({ completionNote: TASK_MESSAGES.NOTE_TOO_LONG });
				}
				if (note === "") note = null;
			}
			const done = body.status === "done";
			const row = await updateTask(tx, task.id, {
				status: body.status,
				completedAt: done
					? task.status === "done" && task.completedAt
						? task.completedAt
						: now
					: null,
				completionNote: done ? note : null,
				completionFile: done ? (body.completionFile ?? null) : null,
				updatedAt: now,
			});
			await this.audit.record(tx, {
				workspaceId: task.workspaceId,
				actorMembershipId: caller.membershipId,
				action: "task.moved",
				target: `task:${task.id}`,
				summary: `Task ${task.id} ${task.status} to ${body.status}`,
			});
			return toTaskDto(row);
		});
}
