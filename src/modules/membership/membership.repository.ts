import { and, eq, isNull } from "drizzle-orm";
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

export const insertMembership = async (tx: Tx, values: NewMembership) => {
	const [row] = await tx.insert(memberships).values(values).returning();
	if (!row) throw new Error("membership insert returned no row");
	return row;
};
