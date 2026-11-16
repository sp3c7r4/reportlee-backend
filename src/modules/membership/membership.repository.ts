import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db/postgres.db";
import { spaces } from "@/modules/space/space.model";
import { users } from "@/modules/user/user.model";
import { workspaces } from "@/modules/workspace/workspace.model";
import { isActiveMember } from "./active";
import {
	type MembershipRole,
	memberships,
	type NewMembership,
} from "./membership.model";

/** @info - Plain `(tx, ...)` functions (D6). Pass `getReader()` outside a transaction. */

export interface Caller {
	membershipId: number;
	userId: number;
	workspaceId: number;
	role: MembershipRole;
	spaceId: number | null;
	spaceName: string | null;
}

/**
 * @info - The query behind `MembershipService.resolve`. An ACTIVE Membership in a non-deleted
 * Workspace, held by a person who is neither deleted nor suspended. Nothing else decides access.
 */
export const resolveCaller = async (
	tx: Tx,
	userId: number,
	workspaceId: number,
): Promise<Caller | null> => {
	const [row] = await tx
		.select({
			membershipId: memberships.id,
			userId: memberships.userId,
			workspaceId: memberships.workspaceId,
			role: memberships.role,
			spaceId: memberships.spaceId,
			spaceName: spaces.name,
		})
		.from(memberships)
		.innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
		.innerJoin(users, eq(users.id, memberships.userId))
		.leftJoin(spaces, eq(spaces.id, memberships.spaceId))
		.where(
			and(
				eq(memberships.userId, userId),
				eq(memberships.workspaceId, workspaceId),
				isActiveMember(),
				isNull(workspaces.deletedAt),
			),
		)
		.limit(1);
	return row ?? null;
};

/** @info - Every active Membership the person holds, in Workspaces that still exist. */
export const listActiveForUser = async (tx: Tx, userId: number) =>
	tx
		.select({
			membership: memberships,
			workspace: workspaces,
			spaceName: spaces.name,
		})
		.from(memberships)
		.innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
		.innerJoin(users, eq(users.id, memberships.userId))
		.leftJoin(spaces, eq(spaces.id, memberships.spaceId))
		.where(
			and(
				eq(memberships.userId, userId),
				isActiveMember(),
				isNull(workspaces.deletedAt),
			),
		)
		.orderBy(memberships.id);

export const setLastWorkspace = async (
	tx: Tx,
	userId: number,
	workspaceId: number,
) => {
	await tx
		.update(users)
		.set({ lastWorkspaceId: workspaceId })
		.where(eq(users.id, userId));
};

export const findUserBasics = async (tx: Tx, userId: number) => {
	const [row] = await tx
		.select({
			id: users.id,
			firstName: users.firstName,
			lastName: users.lastName,
			email: users.email,
			lastWorkspaceId: users.lastWorkspaceId,
		})
		.from(users)
		.where(
			and(
				eq(users.id, userId),
				isNull(users.deletedAt),
				isNull(users.suspendedAt),
			),
		)
		.limit(1);
	return row ?? null;
};

/** @info - A Membership of this Workspace joined to its person, whatever its state. */
export const findMemberInWorkspace = async (
	tx: Tx,
	workspaceId: number,
	membershipId: number,
) => {
	const [row] = await tx
		.select({
			membership: memberships,
			personLive: sql<boolean>`(${users.deletedAt} IS NULL AND ${users.suspendedAt} IS NULL)`,
		})
		.from(memberships)
		.innerJoin(users, eq(users.id, memberships.userId))
		.where(
			and(
				eq(memberships.id, membershipId),
				eq(memberships.workspaceId, workspaceId),
			),
		)
		.limit(1);
	return row ?? null;
};

export const updateMembership = async (
	tx: Tx,
	membershipId: number,
	values: Partial<Pick<NewMembership, "role" | "spaceId" | "active">>,
) => {
	const [row] = await tx
		.update(memberships)
		.set(values)
		.where(eq(memberships.id, membershipId))
		.returning();
	if (!row) throw new Error("membership update returned no row");
	return row;
};

/** @info - Active members (D26) of one Space. */
export const countActiveInSpace = async (tx: Tx, spaceId: number) => {
	const [row] = await tx
		.select({ total: count() })
		.from(memberships)
		.innerJoin(users, eq(users.id, memberships.userId))
		.where(and(eq(memberships.spaceId, spaceId), isActiveMember()));
	return Number(row?.total ?? 0);
};

/**
 * @info - Locks the active Admin rows of a Workspace (D6, after the Workspace lock). Two requests that
 * would each remove an Admin serialise here, so the count they read is the count that is true.
 */
export const lockActiveAdmins = async (tx: Tx, workspaceId: number) =>
	tx
		.select({ id: memberships.id })
		.from(memberships)
		.innerJoin(users, eq(users.id, memberships.userId))
		.where(
			and(
				eq(memberships.workspaceId, workspaceId),
				eq(memberships.role, "admin"),
				isActiveMember(),
			),
		)
		.for("update", { of: memberships });

export const listRoster = async (
	tx: Tx,
	workspaceId: number,
	includeInactive: boolean,
) =>
	tx
		.select({
			membership: memberships,
			firstName: users.firstName,
			lastName: users.lastName,
			email: users.email,
			personLive: sql<boolean>`(${users.deletedAt} IS NULL AND ${users.suspendedAt} IS NULL)`,
			spaceName: spaces.name,
		})
		.from(memberships)
		.innerJoin(users, eq(users.id, memberships.userId))
		.leftJoin(spaces, eq(spaces.id, memberships.spaceId))
		.where(
			includeInactive
				? eq(memberships.workspaceId, workspaceId)
				: and(eq(memberships.workspaceId, workspaceId), isActiveMember()),
		)
		.orderBy(asc(sql`lower(${users.firstName})`), asc(memberships.id))
		.limit(1000);

export const findByUserWorkspace = async (
	tx: Tx,
	workspaceId: number,
	userId: number,
) => {
	const [row] = await tx
		.select()
		.from(memberships)
		.where(
			and(
				eq(memberships.workspaceId, workspaceId),
				eq(memberships.userId, userId),
			),
		)
		.limit(1);
	return row ?? null;
};

export const insertMembership = async (tx: Tx, values: NewMembership) => {
	const [row] = await tx.insert(memberships).values(values).returning();
	if (!row) throw new Error("membership insert returned no row");
	return row;
};
