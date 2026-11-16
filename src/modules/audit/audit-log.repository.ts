import { desc, eq } from "drizzle-orm";
import type { Tx } from "@/db/postgres.db";
import { audit_logs, type NewAuditLog } from "./audit-log.model";

/** @info - Insert and list only. No update, no delete: the trail must not be editable. */
export const insertAuditLog = async (tx: Tx, values: NewAuditLog) => {
	await tx.insert(audit_logs).values(values);
};

export const listAuditLogs = async (tx: Tx, workspaceId: number, limit = 100) =>
	tx
		.select()
		.from(audit_logs)
		.where(eq(audit_logs.workspaceId, workspaceId))
		.orderBy(desc(audit_logs.createdAt))
		.limit(limit);
