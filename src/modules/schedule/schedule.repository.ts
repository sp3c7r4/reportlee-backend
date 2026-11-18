import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db/postgres.db";
import { workspaces } from "@/modules/workspace/workspace.model";
import { BASELINE_FROM, type PeriodSpec } from "./period-calendar";
import { PERIOD_LOCK_CLASS } from "./schedule.constants";
import {
	type ReportingPeriodRow,
	reportingPeriods,
	type WorkspaceScheduleRow,
	workspaceSchedules,
} from "./schedule.model";

/** @info - Plain `(tx, ...)` functions, as in the space and workspace modules. */

/** @info - D31: the period lock. Callers take it before any Workspace row lock. */
export const lockPeriods = async (tx: Tx, workspaceId: number) => {
	await tx.execute(
		sql`select pg_advisory_xact_lock(${PERIOD_LOCK_CLASS}::int, ${workspaceId}::int)`,
	);
};

export const listVersions = async (
	tx: Tx,
	workspaceId: number,
): Promise<WorkspaceScheduleRow[]> =>
	tx
		.select()
		.from(workspaceSchedules)
		.where(eq(workspaceSchedules.workspaceId, workspaceId))
		.orderBy(asc(workspaceSchedules.effectiveFrom));

export const insertVersion = async (
	tx: Tx,
	values: typeof workspaceSchedules.$inferInsert,
) => {
	await tx.insert(workspaceSchedules).values(values);
};

/** @info - Removes a version that has not started, so PUT replaces a pending change. */
export const deletePendingVersions = async (
	tx: Tx,
	workspaceId: number,
	now: Date,
) => {
	await tx
		.delete(workspaceSchedules)
		.where(
			and(
				eq(workspaceSchedules.workspaceId, workspaceId),
				gt(workspaceSchedules.effectiveFrom, now),
			),
		);
};

/**
 * @info - D26: writes the R1 baseline row in the Workspace's current zone, once. Never locks: the
 * caller holds the period lock.
 */
export const ensureBaseline = async (
	tx: Tx,
	workspaceId: number,
	now: Date,
) => {
	const [ws] = await tx
		.select({ timeZone: workspaces.timeZone })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1);
	if (!ws) return;
	await tx
		.insert(workspaceSchedules)
		.values({
			workspaceId,
			cadence: "weekly",
			weekday: "Monday",
			timeOfDay: "17:00",
			timeZone: ws.timeZone,
			effectiveFrom: BASELINE_FROM,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing({
			target: [
				workspaceSchedules.workspaceId,
				workspaceSchedules.effectiveFrom,
			],
		});
};

export const hasAnyPeriod = async (tx: Tx, workspaceId: number) => {
	const [row] = await tx
		.select({ id: reportingPeriods.id })
		.from(reportingPeriods)
		.where(eq(reportingPeriods.workspaceId, workspaceId))
		.limit(1);
	return Boolean(row);
};

export const findPeriodsByStart = async (
	tx: Tx,
	workspaceId: number,
	starts: Date[],
): Promise<ReportingPeriodRow[]> => {
	if (starts.length === 0) return [];
	return tx
		.select()
		.from(reportingPeriods)
		.where(
			and(
				eq(reportingPeriods.workspaceId, workspaceId),
				inArray(reportingPeriods.startsAt, starts),
			),
		);
};

export const findPeriodById = async (
	tx: Tx,
	periodId: number,
): Promise<ReportingPeriodRow | null> => {
	const [row] = await tx
		.select()
		.from(reportingPeriods)
		.where(eq(reportingPeriods.id, periodId))
		.limit(1);
	return row ?? null;
};

/** @info - Periods are inserted, never updated (invariant: a period is not rewritten). */
export const insertPeriodIfMissing = async (
	tx: Tx,
	workspaceId: number,
	spec: PeriodSpec,
	now: Date,
) => {
	await tx
		.insert(reportingPeriods)
		.values({
			workspaceId,
			label: spec.label,
			startsAt: spec.startsAt,
			endsAt: spec.endsAt,
			dueAt: spec.dueAt,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing({
			target: [reportingPeriods.workspaceId, reportingPeriods.startsAt],
		});
};
