import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db/postgres.db";
import { isActiveMember } from "@/modules/membership/active";
import { memberships } from "@/modules/membership/membership.model";
import { spaces } from "@/modules/space/space.model";
import { users } from "@/modules/user/user.model";
import {
	type NewReportRow,
	type ReportContentSnapshot,
	type ReportEventKind,
	type ReportRow,
	reportEvents,
	reportRevisions,
	reports,
} from "./report.model";

/** @info - Plain `(tx, ...)` functions. Every read filters `deleted_at IS NULL` on purpose. */

const live = (id: number) => and(eq(reports.id, id), isNull(reports.deletedAt));

export const findLiveReport = async (
	tx: Tx,
	id: number,
): Promise<ReportRow | null> => {
	const [row] = await tx.select().from(reports).where(live(id)).limit(1);
	return row ?? null;
};

/** @info - Carry-over 4: the locked read re-checks `deleted_at`, so a concurrent delete gives 404. */
export const lockLiveReport = async (
	tx: Tx,
	id: number,
): Promise<ReportRow | null> => {
	const [row] = await tx.select().from(reports).where(live(id)).for("update");
	return row ?? null;
};

const liveFor = (periodId: number, authorMembershipId: number) =>
	and(
		eq(reports.periodId, periodId),
		eq(reports.authorMembershipId, authorMembershipId),
		isNull(reports.deletedAt),
	);

export const findLiveFor = async (
	tx: Tx,
	periodId: number,
	authorMembershipId: number,
): Promise<ReportRow | null> => {
	const [row] = await tx
		.select()
		.from(reports)
		.where(liveFor(periodId, authorMembershipId))
		.limit(1);
	return row ?? null;
};

export const lockLiveFor = async (
	tx: Tx,
	periodId: number,
	authorMembershipId: number,
): Promise<ReportRow | null> => {
	const [row] = await tx
		.select()
		.from(reports)
		.where(liveFor(periodId, authorMembershipId))
		.for("update");
	return row ?? null;
};

/** @info - The partial unique index decides between parallel first saves. */
export const insertDraftIfMissing = async (tx: Tx, values: NewReportRow) => {
	await tx
		.insert(reports)
		.values(values)
		.onConflictDoNothing({
			target: [reports.periodId, reports.authorMembershipId],
			where: sql`${reports.deletedAt} IS NULL`,
		});
};

export const updateReport = async (
	tx: Tx,
	id: number,
	values: Partial<NewReportRow>,
): Promise<ReportRow> => {
	const [row] = await tx
		.update(reports)
		.set(values)
		.where(eq(reports.id, id))
		.returning();
	if (!row) throw new Error("report update returned no row");
	return row;
};

export const insertRevision = async (
	tx: Tx,
	reportId: number,
	previous: ReportContentSnapshot,
	createdAt: Date,
) => {
	await tx.insert(reportRevisions).values({ reportId, previous, createdAt });
};

export const insertEvent = async (
	tx: Tx,
	reportId: number,
	kind: ReportEventKind,
	actorMembershipId: number,
	createdAt: Date,
) => {
	await tx
		.insert(reportEvents)
		.values({ reportId, kind, actorMembershipId, createdAt });
};

/** @info - Batched: one query for every report on a page (no N+1). */
export const revisionsFor = async (tx: Tx, reportIds: number[]) =>
	reportIds.length === 0
		? []
		: tx
				.select()
				.from(reportRevisions)
				.where(inArray(reportRevisions.reportId, reportIds))
				.orderBy(asc(reportRevisions.createdAt), asc(reportRevisions.id));

export const eventsFor = async (tx: Tx, reportIds: number[]) =>
	reportIds.length === 0
		? []
		: tx
				.select()
				.from(reportEvents)
				.where(inArray(reportEvents.reportId, reportIds))
				.orderBy(asc(reportEvents.createdAt), asc(reportEvents.id));

/** @info - E8: only the caller's own reports. A list is a second path to a draft, so it filters by author too. */
export const listOwn = async (
	tx: Tx,
	authorMembershipId: number,
	options: {
		periodId?: number;
		drafts: boolean;
		limit: number;
		offset: number;
	},
): Promise<ReportRow[]> => {
	const filters = [
		eq(reports.authorMembershipId, authorMembershipId),
		isNull(reports.deletedAt),
		options.drafts
			? eq(reports.submissionStatus, "draft")
			: ne(reports.submissionStatus, "draft"),
	];
	if (options.periodId !== undefined) {
		filters.push(eq(reports.periodId, options.periodId));
	}
	return tx
		.select()
		.from(reports)
		.where(and(...filters))
		.orderBy(
			options.drafts ? desc(reports.updatedAt) : desc(reports.submittedAt),
			desc(reports.id),
		)
		.limit(options.limit)
		.offset(options.offset);
};

export const spaceHead = async (tx: Tx, spaceId: number) => {
	const [row] = await tx
		.select({ head: spaces.headMembershipId, kpiTemplate: spaces.kpiTemplate })
		.from(spaces)
		.where(eq(spaces.id, spaceId))
		.limit(1);
	return row ?? null;
};

export const membershipRole = async (tx: Tx, membershipId: number) => {
	const [row] = await tx
		.select({ role: memberships.role })
		.from(memberships)
		.where(eq(memberships.id, membershipId))
		.limit(1);
	return row?.role ?? null;
};

/** @info - D15: which of these ids are active Memberships of the Workspace. */
export const activeMemberIds = async (
	tx: Tx,
	workspaceId: number,
	ids: number[],
): Promise<Set<number>> => {
	if (ids.length === 0) return new Set();
	const rows = await tx
		.select({ id: memberships.id })
		.from(memberships)
		.innerJoin(users, eq(users.id, memberships.userId))
		.where(
			and(
				eq(memberships.workspaceId, workspaceId),
				inArray(memberships.id, ids),
				isActiveMember(),
			),
		);
	return new Set(rows.map((r) => r.id));
};
