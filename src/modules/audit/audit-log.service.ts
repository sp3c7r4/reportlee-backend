import type { Tx } from "@/db/postgres.db";
import { insertAuditLog } from "./audit-log.repository";

export type AuditAction =
	| "workspace.created"
	| "workspace.updated"
	| "space.created"
	| "space.updated"
	| "space.archived"
	| "role.change"
	| "member.deactivated"
	| "member.reactivated"
	| "member.joined"
	| "invitation.sent"
	| "invitation.revoked"
	| "report.submitted"
	| "report.edited"
	| "report.deleted"
	| "schedule.change";

export class AuditLogService {
	private static instance: AuditLogService;

	static getInstance() {
		if (!this.instance) this.instance = new AuditLogService();
		return this.instance;
	}

	private constructor() {}

	/**
	 * @info - Written in the same transaction as the change it describes (D14). The summary holds
	 * ids and key names only, never an email, a name or a token.
	 */
	record = async (
		tx: Tx,
		entry: {
			workspaceId: number;
			actorMembershipId: number | null;
			action: AuditAction;
			target: string;
			summary: string;
		},
	) => {
		await insertAuditLog(tx, entry);
	};
}
