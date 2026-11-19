import type { TaskCompletionFile, TaskRow } from "./task.model";

/** @info - Mirrors `Task` in the frontend's src/data/tasks.ts. Ids are strings, `dueAt` is YYYY-MM-DD. */
export interface TaskDto {
	id: string;
	reportId: string;
	title: string;
	assigneeMembershipId: string;
	assignedByMembershipId: string;
	dueAt: string;
	status: "todo" | "doing" | "done";
	priority: "low" | "medium" | "high" | "critical";
	completionNote: string | null;
	completionFile: TaskCompletionFile | null;
	completedAt: string | null;
	createdAt: string;
}

export const toTaskDto = (t: TaskRow): TaskDto => ({
	id: String(t.id),
	reportId: String(t.reportId),
	title: t.title,
	assigneeMembershipId: String(t.assigneeMembershipId),
	assignedByMembershipId: String(t.assignedByMembershipId),
	dueAt: t.dueOn,
	status: t.status,
	priority: t.priority,
	completionNote: t.completionNote,
	completionFile: t.completionFile ?? null,
	completedAt: t.completedAt?.toISOString() ?? null,
	createdAt: t.createdAt.toISOString(),
});
