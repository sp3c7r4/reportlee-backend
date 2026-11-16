import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/postgres.db";
import { memberships } from "@/modules/membership/membership.model";
import { spaces } from "@/modules/space/space.model";
import { users } from "@/modules/user/user.model";
import { workspaces } from "@/modules/workspace/workspace.model";
import { invitations } from "./invitation.model";

/**
 * @info - Plain `(tx, ...)` functions (D6). Timestamps use the database clock (`now()`), never the
 * Node clock, so expiry is decided in one place whatever the session time zone is.
 */

/** @info - D10: pending rows past `expires_at` become `expired`. Runs only inside an invitation create. */
export const sweepExpired = async (tx: Tx, workspaceId: number) => {
	await tx
		.update(invitations)
		.set({ status: "expired" })
		.where(
			and(
				eq(invitations.workspaceId, workspaceId),
				eq(invitations.status, "pending"),
				sql`${invitations.expiresAt} <= now()`,
			),
		);
};

export const insertInvitation = async (
	tx: Tx,
	values: {
		workspaceId: number;
		email: string;
		role: "staff" | "head" | "admin";
		spaceId: number | null;
		tokenHash: string;
		invitedByMembershipId: number;
	},
) => {
	const [row] = await tx
		.insert(invitations)
		.values({ ...values, expiresAt: sql`now() + interval '7 days'` })
		.returning();
	if (!row) throw new Error("invitation insert returned no row");
	return row;
};

const listColumns = {
	invitation: invitations,
	spaceName: spaces.name,
	expired: sql<boolean>`(${invitations.expiresAt} <= now())`,
};

/** @info - Pending rows only. The caller decides whether a Head sees all of them or one Space's. */
export const listPending = async (
	tx: Tx,
	workspaceId: number,
	onlySpaceId: number | null,
) =>
	tx
		.select(listColumns)
		.from(invitations)
		.leftJoin(spaces, eq(spaces.id, invitations.spaceId))
		.where(
			and(
				eq(invitations.workspaceId, workspaceId),
				eq(invitations.status, "pending"),
				onlySpaceId === null ? undefined : eq(invitations.spaceId, onlySpaceId),
			),
		)
		.orderBy(desc(invitations.createdAt), desc(invitations.id));

export const listByIds = async (tx: Tx, ids: number[]) =>
	tx
		.select(listColumns)
		.from(invitations)
		.leftJoin(spaces, eq(spaces.id, invitations.spaceId))
		.where(
			sql`${invitations.id} in (${sql.join(
				ids.map((i) => sql`${i}`),
				sql`, `,
			)})`,
		);

export const findInWorkspace = async (
	tx: Tx,
	workspaceId: number,
	invitationId: number,
) => {
	const [row] = await tx
		.select()
		.from(invitations)
		.where(
			and(
				eq(invitations.id, invitationId),
				eq(invitations.workspaceId, workspaceId),
			),
		)
		.limit(1);
	return row ?? null;
};

/** @info - Conditional update: zero rows means someone else got there first. */
export const revokeIfPending = async (tx: Tx, invitationId: number) => {
	const rows = await tx
		.update(invitations)
		.set({ status: "revoked" })
		.where(
			and(eq(invitations.id, invitationId), eq(invitations.status, "pending")),
		)
		.returning({ id: invitations.id });
	return rows.length > 0;
};

/** @info - Single use (D9): only a pending, unexpired row can be accepted, and only once. */
export const acceptIfPending = async (
	tx: Tx,
	invitationId: number,
	userId: number,
) => {
	const rows = await tx
		.update(invitations)
		.set({
			status: "accepted",
			acceptedAt: sql`now()`,
			acceptedByUserId: userId,
		})
		.where(
			and(
				eq(invitations.id, invitationId),
				eq(invitations.status, "pending"),
				sql`${invitations.expiresAt} > now()`,
			),
		)
		.returning({ id: invitations.id });
	return rows.length > 0;
};

/** @info - The row behind a token hash, with what the preview shows. */
export const findByTokenHash = async (tx: Tx, tokenHash: string) => {
	const [row] = await tx
		.select({
			invitation: invitations,
			workspace: workspaces,
			spaceName: spaces.name,
			expired: sql<boolean>`(${invitations.expiresAt} <= now())`,
		})
		.from(invitations)
		.innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
		.leftJoin(spaces, eq(spaces.id, invitations.spaceId))
		.where(eq(invitations.tokenHash, tokenHash))
		.limit(1);
	return row ?? null;
};

/** @info - Is this address already in the Workspace, and in what state. */
export const findMemberByEmail = async (
	tx: Tx,
	workspaceId: number,
	email: string,
) => {
	const [row] = await tx
		.select({
			active: memberships.active,
			personLive: sql<boolean>`(${users.deletedAt} IS NULL AND ${users.suspendedAt} IS NULL)`,
		})
		.from(memberships)
		.innerJoin(users, eq(users.id, memberships.userId))
		.where(
			and(
				eq(memberships.workspaceId, workspaceId),
				sql`lower(${users.email}) = ${email}`,
			),
		)
		.limit(1);
	return row ?? null;
};

export const pendingForEmail = async (
	tx: Tx,
	workspaceId: number,
	email: string,
) => {
	const [row] = await tx
		.select({ id: invitations.id })
		.from(invitations)
		.where(
			and(
				eq(invitations.workspaceId, workspaceId),
				eq(invitations.email, email),
				eq(invitations.status, "pending"),
			),
		)
		.limit(1);
	return Boolean(row);
};

export const pendingHeadInviteForSpace = async (tx: Tx, spaceId: number) => {
	const [row] = await tx
		.select({ id: invitations.id })
		.from(invitations)
		.where(
			and(
				eq(invitations.spaceId, spaceId),
				eq(invitations.role, "head"),
				eq(invitations.status, "pending"),
			),
		)
		.limit(1);
	return Boolean(row);
};
