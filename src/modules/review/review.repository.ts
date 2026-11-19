import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db/postgres.db";
import { isActiveMember } from "@/modules/membership/active";
import { memberships } from "@/modules/membership/membership.model";
import { type ReportRow, reports } from "@/modules/report/report.model";
import { spaces } from "@/modules/space/space.model";
import { users } from "@/modules/user/user.model";
import { QUEUE_CAP } from "./review.message";

/** @info - Plain `(tx, ...)` functions. Every read filters `deleted_at IS NULL` on purpose (D25). */

/** @info - V1: the Spaces this Membership is the current Head of. Recomputed on every read. */
export const headedSpaceIds = async (
	tx: Tx,
	membershipId: number,
): Promise<number[]> => {
	const rows = await tx
		.select({ id: spaces.id })
		.from(spaces)
		.where(eq(spaces.headMembershipId, membershipId));
	return rows.map((r) => r.id);
};

/**
 * @info - Submitted reports of one period that `caller` may review. `spaceIds` null means the whole
 * Workspace (Admin). A Head's scope is the headed Spaces, minus reports written by a Head-role
 * author: those go to the Admins (V1). Never the caller's own, never a draft.
 */
export const queueReports = async (
	tx: Tx,
	options: {
		workspaceId: number;
		periodId: number;
		callerMembershipId: number;
		spaceIds: number[] | null;
	},
): Promise<ReportRow[]> => {
	if (options.spaceIds !== null && options.spaceIds.length === 0) return [];
	const filters = [
		eq(reports.workspaceId, options.workspaceId),
		eq(reports.periodId, options.periodId),
		isNull(reports.deletedAt),
		ne(reports.submissionStatus, "draft"),
		ne(reports.authorMembershipId, options.callerMembershipId),
	];
	if (options.spaceIds !== null) {
		filters.push(
			inArray(reports.spaceId, options.spaceIds),
			ne(memberships.role, "head"),
		);
	}
	const rows = await tx
		.select({ report: reports })
		.from(reports)
		.innerJoin(memberships, eq(memberships.id, reports.authorMembershipId))
		.where(and(...filters))
		.orderBy(asc(reports.submittedAt), asc(reports.id))
		.limit(QUEUE_CAP);
	return rows.map((r) => r.report);
};

export interface MissingMember {
	membershipId: number;
	firstName: string;
	lastName: string;
	role: "staff" | "head";
	space: string | null;
	hasDraft: boolean;
}

/**
 * @info - D23, the backend twin of `missingFor` in the frontend: active, not Admin, no submitted
 * report in the period. A draft counts as missing and sets `hasDraft`. The caller is left out.
 */
export const missingMembers = async (
	tx: Tx,
	options: {
		workspaceId: number;
		periodId: number;
		callerMembershipId: number;
		spaceIds: number[] | null;
	},
): Promise<MissingMember[]> => {
	if (options.spaceIds !== null && options.spaceIds.length === 0) return [];
	const filters = [
		eq(memberships.workspaceId, options.workspaceId),
		isActiveMember(),
		ne(memberships.role, "admin"),
		ne(memberships.id, options.callerMembershipId),
		sql`NOT EXISTS (SELECT 1 FROM ${reports} r WHERE r.author_membership_id = ${memberships.id} AND r.period_id = ${options.periodId} AND r.deleted_at IS NULL AND r.submission_status <> 'draft')`,
	];
	if (options.spaceIds !== null) {
		filters.push(inArray(memberships.spaceId, options.spaceIds));
	}
	const rows = await tx
		.select({
			membershipId: memberships.id,
			firstName: users.firstName,
			lastName: users.lastName,
			role: memberships.role,
			space: spaces.name,
			hasDraft: sql<boolean>`EXISTS (SELECT 1 FROM ${reports} r WHERE r.author_membership_id = ${memberships.id} AND r.period_id = ${options.periodId} AND r.deleted_at IS NULL AND r.submission_status = 'draft')`,
		})
		.from(memberships)
		.innerJoin(users, eq(users.id, memberships.userId))
		.leftJoin(spaces, eq(spaces.id, memberships.spaceId))
		.where(and(...filters))
		.orderBy(asc(sql`lower(${users.firstName})`), asc(memberships.id));
	return rows.map((r) => ({
		...r,
		role: r.role as "staff" | "head",
	}));
};
