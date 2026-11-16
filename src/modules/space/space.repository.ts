import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db/postgres.db";
import { isActiveMember } from "@/modules/membership/active";
import { memberships } from "@/modules/membership/membership.model";
import { users } from "@/modules/user/user.model";
import { type NewSpace, type Space, spaces } from "./space.model";

/** @info - Plain `(tx, ...)` functions (D6). */

export const listSpaces = async (tx: Tx, workspaceId: number) =>
	tx
		.select()
		.from(spaces)
		.where(eq(spaces.workspaceId, workspaceId))
		.orderBy(asc(sql`lower(${spaces.name})`), asc(spaces.id));

/** @info - Scoped to the Workspace: a Space id from another Workspace is simply not found. */
export const findSpace = async (
	tx: Tx,
	workspaceId: number,
	spaceId: number,
): Promise<Space | null> => {
	const [row] = await tx
		.select()
		.from(spaces)
		.where(and(eq(spaces.id, spaceId), eq(spaces.workspaceId, workspaceId)))
		.limit(1);
	return row ?? null;
};

export const countSpaces = async (tx: Tx, workspaceId: number) => {
	const [row] = await tx
		.select({ total: count() })
		.from(spaces)
		.where(eq(spaces.workspaceId, workspaceId));
	return Number(row?.total ?? 0);
};

export const spaceNameTaken = async (
	tx: Tx,
	workspaceId: number,
	name: string,
	exceptSpaceId?: number,
) => {
	const rows = await tx
		.select({ id: spaces.id })
		.from(spaces)
		.where(
			and(
				eq(spaces.workspaceId, workspaceId),
				sql`lower(${spaces.name}) = ${name.toLowerCase()}`,
			),
		);
	return rows.some((r) => r.id !== exceptSpaceId);
};

export const insertSpace = async (tx: Tx, values: NewSpace): Promise<Space> => {
	const [row] = await tx.insert(spaces).values(values).returning();
	if (!row) throw new Error("space insert returned no row");
	return row;
};

export const updateSpaceRow = async (
	tx: Tx,
	spaceId: number,
	values: Partial<
		Pick<NewSpace, "name" | "headMembershipId" | "archivedAt" | "kpiTemplate">
	>,
): Promise<Space> => {
	const [row] = await tx
		.update(spaces)
		.set(values)
		.where(eq(spaces.id, spaceId))
		.returning();
	if (!row) throw new Error("space update returned no row");
	return row;
};

/** @info - Frees the Head slot, but only when this Membership holds it. */
export const clearHeadIf = async (
	tx: Tx,
	spaceId: number,
	membershipId: number,
) => {
	await tx
		.update(spaces)
		.set({ headMembershipId: null })
		.where(
			and(eq(spaces.id, spaceId), eq(spaces.headMembershipId, membershipId)),
		);
};

export const setHeadSlot = async (
	tx: Tx,
	spaceId: number,
	membershipId: number,
) => {
	await tx
		.update(spaces)
		.set({ headMembershipId: membershipId })
		.where(eq(spaces.id, spaceId));
};

/** @info - Active members (D26) per Space. */
export const spaceMemberCounts = async (
	tx: Tx,
	spaceIds: number[],
): Promise<Map<number, number>> => {
	if (spaceIds.length === 0) return new Map();
	const rows = await tx
		.select({ spaceId: memberships.spaceId, total: count() })
		.from(memberships)
		.innerJoin(users, eq(users.id, memberships.userId))
		.where(and(inArray(memberships.spaceId, spaceIds), isActiveMember()))
		.groupBy(memberships.spaceId);
	return new Map(
		rows.flatMap((r) =>
			r.spaceId === null ? [] : [[r.spaceId, Number(r.total)] as const],
		),
	);
};
