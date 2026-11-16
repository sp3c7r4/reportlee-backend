import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db/postgres.db";
import { isActiveMember } from "@/modules/membership/active";
import { memberships } from "@/modules/membership/membership.model";
import { users } from "@/modules/user/user.model";
import {
	type NewWorkspace,
	type Workspace,
	workspaces,
} from "./workspace.model";

/**
 * @info - Plain `(tx, ...)` functions, not a RelationalRepository: the locked flows need explicit
 * control of `deleted_at` and of the transaction handle (D6). Pass `getReader()` outside a
 * transaction.
 */

/** @info - Locks the Workspace row. Always the first lock taken, so flows cannot deadlock (D6). */
export const lockWorkspace = async (
	tx: Tx,
	workspaceId: number,
): Promise<Workspace | null> => {
	const [row] = await tx
		.select()
		.from(workspaces)
		.where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
		.for("update");
	return row ?? null;
};

export const findWorkspace = async (
	tx: Tx,
	workspaceId: number,
): Promise<Workspace | null> => {
	const [row] = await tx
		.select()
		.from(workspaces)
		.where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
		.limit(1);
	return row ?? null;
};

export const insertWorkspace = async (
	tx: Tx,
	values: NewWorkspace,
): Promise<Workspace> => {
	const [row] = await tx.insert(workspaces).values(values).returning();
	if (!row) throw new Error("workspace insert returned no row");
	return row;
};

export const updateWorkspace = async (
	tx: Tx,
	workspaceId: number,
	values: Partial<Pick<NewWorkspace, "name" | "timeZone" | "locationTagging">>,
): Promise<Workspace> => {
	const [row] = await tx
		.update(workspaces)
		.set(values)
		.where(eq(workspaces.id, workspaceId))
		.returning();
	if (!row) throw new Error("workspace update returned no row");
	return row;
};

/** @info - Case-insensitive, deleted Workspaces keep their slug (the index has no WHERE). */
export const slugExists = async (tx: Tx, slug: string): Promise<boolean> => {
	const [row] = await tx
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(sql`lower(${workspaces.slug}) = ${slug.toLowerCase()}`)
		.limit(1);
	return Boolean(row);
};

/** @info - Active members per Workspace (D26). */
export const memberCounts = async (
	tx: Tx,
	workspaceIds: number[],
): Promise<Map<number, number>> => {
	if (workspaceIds.length === 0) return new Map();
	const rows = await tx
		.select({ workspaceId: memberships.workspaceId, total: count() })
		.from(memberships)
		.innerJoin(users, eq(users.id, memberships.userId))
		.where(
			and(inArray(memberships.workspaceId, workspaceIds), isActiveMember()),
		)
		.groupBy(memberships.workspaceId);
	return new Map(rows.map((r) => [r.workspaceId, Number(r.total)]));
};
