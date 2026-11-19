import {
	and,
	asc,
	eq,
	gte,
	inArray,
	isNull,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import type { Tx } from "@/db/postgres.db";
import { reports } from "@/modules/report/report.model";
import { DONE_WINDOW_DAYS, LIST_CAP } from "./task.message";
import { type NewTaskRow, type TaskRow, tasks } from "./task.model";

/** @info - Plain `(tx, ...)` functions. A task of a deleted report is never listed (D25). */

export const insertTask = async (
	tx: Tx,
	values: NewTaskRow,
): Promise<TaskRow> => {
	const [row] = await tx.insert(tasks).values(values).returning();
	if (!row) throw new Error("task insert returned no row");
	return row;
};

export const lockTask = async (tx: Tx, id: number): Promise<TaskRow | null> => {
	const [row] = await tx
		.select()
		.from(tasks)
		.where(eq(tasks.id, id))
		.for("update");
	return row ?? null;
};

export const updateTask = async (
	tx: Tx,
	id: number,
	values: Partial<NewTaskRow>,
): Promise<TaskRow> => {
	const [row] = await tx
		.update(tasks)
		.set(values)
		.where(eq(tasks.id, id))
		.returning();
	if (!row) throw new Error("task update returned no row");
	return row;
};

/** @info - The report behind a task must still be live: used by the move route. */
export const reportIsLive = async (
	tx: Tx,
	reportId: number,
): Promise<boolean> => {
	const [row] = await tx
		.select({ id: reports.id })
		.from(reports)
		.where(and(eq(reports.id, reportId), isNull(reports.deletedAt)))
		.limit(1);
	return Boolean(row);
};

/**
 * @info - One list for one view. `who` is the filter the view adds: the assignee, the assigner, the
 * assignees inside a Space, or nothing (every task of the Workspace). Done tasks older than 14
 * days are dropped here, so the client cannot ask for them.
 */
export const listTasks = async (
	tx: Tx,
	options: {
		workspaceId: number;
		who: SQL | undefined;
		now: Date;
	},
): Promise<TaskRow[]> => {
	const since = new Date(
		options.now.getTime() - DONE_WINDOW_DAYS * 24 * 3_600_000,
	);
	const filters = [
		eq(tasks.workspaceId, options.workspaceId),
		isNull(reports.deletedAt),
		or(sql`${tasks.status} <> 'done'`, gte(tasks.completedAt, since)),
	];
	if (options.who) filters.push(options.who);
	const rows = await tx
		.select({ task: tasks })
		.from(tasks)
		.innerJoin(reports, eq(reports.id, tasks.reportId))
		.where(and(...filters))
		.orderBy(asc(tasks.dueOn), asc(tasks.id))
		.limit(LIST_CAP);
	return rows.map((r) => r.task);
};

export const taskWho = {
	assignee: (membershipId: number) =>
		eq(tasks.assigneeMembershipId, membershipId),
	assigner: (membershipId: number) =>
		eq(tasks.assignedByMembershipId, membershipId),
	assigneesIn: (membershipIds: number[]) =>
		inArray(tasks.assigneeMembershipId, membershipIds),
};
