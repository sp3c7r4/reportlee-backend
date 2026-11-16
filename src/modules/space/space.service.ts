import { getDb, getReader, type Tx } from "@/db/postgres.db";
import {
	throwBadRequestError,
	throwConflictError,
	throwForbiddenError,
	throwNotFoundError,
	throwUnprocessableError,
} from "@/helpers/errors";
import { isUniqueViolation } from "@/helpers/pg-error";
import { AuditLogService } from "@/modules/audit/audit-log.service";
import {
	type Caller,
	MembershipService,
} from "@/modules/membership/membership.service";
import { WORKSPACE_MESSAGES } from "@/modules/workspace/workspace.message";
import { lockWorkspace } from "@/modules/workspace/workspace.repository";
import { MAX_SPACES, SPACE_MESSAGES } from "./space.message";
import type { KpiTemplateRow, Space } from "./space.model";
import {
	countSpaces,
	findSpace,
	insertSpace,
	listSpaces,
	spaceMemberCounts,
	spaceNameTaken,
	updateSpaceRow,
} from "./space.repository";

export interface SpaceSummaryDto {
	id: string;
	name: string;
	headMembershipId: string | null;
	archived: boolean;
	kpiTemplate: KpiTemplateRow[];
	memberCount: number;
}

export interface SpaceUpdate {
	name?: string;
	headMembershipId?: string | null;
	archived?: boolean;
	kpiTemplate?: KpiTemplateRow[];
}

const toDto = (row: Space, memberCount: number): SpaceSummaryDto => ({
	id: String(row.id),
	name: row.name,
	headMembershipId:
		row.headMembershipId === null ? null : String(row.headMembershipId),
	archived: row.archivedAt !== null,
	kpiTemplate: row.kpiTemplate,
	memberCount,
});

export class SpaceService {
	private static instance: SpaceService;
	private readonly audit = AuditLogService.getInstance();
	private readonly members = MembershipService.getInstance();

	static getInstance() {
		if (!this.instance) this.instance = new SpaceService();
		return this.instance;
	}

	private constructor() {}

	list = async (workspaceId: number): Promise<SpaceSummaryDto[]> => {
		const db = getReader();
		const rows = await listSpaces(db, workspaceId);
		const counts = await spaceMemberCounts(
			db,
			rows.map((r) => r.id),
		);
		return rows.map((r) => toDto(r, counts.get(r.id) ?? 0));
	};

	/** @info - Admin only (route guard). Locks the Workspace so two creates cannot both take the 50th slot. */
	create = async (caller: Caller, name: string): Promise<SpaceSummaryDto> => {
		try {
			return await getDb().transaction(async (tx) => {
				if (!(await lockWorkspace(tx, caller.workspaceId))) {
					return throwNotFoundError(WORKSPACE_MESSAGES.NOT_FOUND);
				}
				if ((await countSpaces(tx, caller.workspaceId)) >= MAX_SPACES) {
					return throwUnprocessableError(SPACE_MESSAGES.LIMIT_REACHED);
				}
				if (await spaceNameTaken(tx, caller.workspaceId, name)) {
					return throwConflictError(SPACE_MESSAGES.NAME_TAKEN(name));
				}
				const row = await insertSpace(tx, {
					workspaceId: caller.workspaceId,
					name,
				});
				await this.audit.record(tx, {
					workspaceId: caller.workspaceId,
					actorMembershipId: caller.membershipId,
					action: "space.created",
					target: `space:${row.id}`,
					summary: `Space ${row.id} created`,
				});
				return toDto(row, 0);
			});
		} catch (error) {
			if (isUniqueViolation(error)) {
				return throwConflictError(SPACE_MESSAGES.NAME_TAKEN(name));
			}
			throw error;
		}
	};

	update = async (
		caller: Caller,
		spaceId: number,
		body: SpaceUpdate,
	): Promise<SpaceSummaryDto> => {
		try {
			return await getDb().transaction((tx) =>
				this.updateLocked(tx, caller, spaceId, body),
			);
		} catch (error) {
			if (isUniqueViolation(error)) {
				return throwConflictError(SPACE_MESSAGES.NAME_TAKEN(body.name ?? ""));
			}
			throw error;
		}
	};

	private updateLocked = async (
		tx: Tx,
		caller: Caller,
		spaceId: number,
		body: SpaceUpdate,
	): Promise<SpaceSummaryDto> => {
		if (!(await lockWorkspace(tx, caller.workspaceId))) {
			return throwNotFoundError(WORKSPACE_MESSAGES.NOT_FOUND);
		}
		const space = await findSpace(tx, caller.workspaceId, spaceId);
		if (!space) return throwNotFoundError(SPACE_MESSAGES.NOT_FOUND);

		/* @info - A Head may send only kpiTemplate, and only for the Space they head (AC13). */
		if (caller.role === "head") {
			const onlyTemplate = Object.keys(body).every((k) => k === "kpiTemplate");
			if (!onlyTemplate || caller.spaceId !== space.id) {
				return throwForbiddenError(WORKSPACE_MESSAGES.FORBIDDEN);
			}
		}

		const changed: string[] = [];
		const values: Parameters<typeof updateSpaceRow>[2] = {};
		let archiving = false;

		if (body.name !== undefined && body.name !== space.name) {
			if (await spaceNameTaken(tx, caller.workspaceId, body.name, space.id)) {
				return throwConflictError(SPACE_MESSAGES.NAME_TAKEN(body.name));
			}
			values.name = body.name;
			changed.push("name");
		}

		if (body.kpiTemplate !== undefined) {
			values.kpiTemplate = body.kpiTemplate;
			changed.push("kpiTemplate");
		}

		if (body.archived !== undefined) {
			const isArchived = space.archivedAt !== null;
			if (body.archived && !isArchived) {
				if ((await this.members.activeCountInSpace(tx, space.id)) > 0) {
					return throwConflictError(SPACE_MESSAGES.ARCHIVE_HAS_MEMBERS);
				}
				values.archivedAt = new Date();
				archiving = true;
			} else if (!body.archived && isArchived) {
				values.archivedAt = null;
				changed.push("restored");
			}
		}

		if (body.headMembershipId !== undefined) {
			const swapped = await this.setHead(
				tx,
				caller,
				space,
				body.headMembershipId,
			);
			if (swapped) {
				values.headMembershipId = swapped.next;
				changed.push("head");
			}
		}

		const row =
			Object.keys(values).length > 0
				? await updateSpaceRow(tx, space.id, values)
				: space;

		if (archiving) {
			await this.audit.record(tx, {
				workspaceId: caller.workspaceId,
				actorMembershipId: caller.membershipId,
				action: "space.archived",
				target: `space:${space.id}`,
				summary: `Space ${space.id} archived`,
			});
		}
		if (changed.length > 0) {
			await this.audit.record(tx, {
				workspaceId: caller.workspaceId,
				actorMembershipId: caller.membershipId,
				action: "space.updated",
				target: `space:${space.id}`,
				summary: `Changed: ${changed.join(", ")}`,
			});
		}
		const counts = await spaceMemberCounts(tx, [row.id]);
		return toDto(row, counts.get(row.id) ?? 0);
	};

	/**
	 * @info - The one path that sets or clears a Head (D12). The previous Head becomes Staff in the
	 * same Space. Returns null when nothing changes. Each role flip writes a role.change row.
	 * The old Head is cleared on the Space row first, so the one-Head unique index never sees two.
	 */
	private setHead = async (
		tx: Tx,
		caller: Caller,
		space: Space,
		target: string | null,
	): Promise<{ next: number | null } | null> => {
		const targetId = target === null ? null : Number(target);
		if (targetId === space.headMembershipId) return null;

		let nextRow: Awaited<
			ReturnType<MembershipService["memberInWorkspace"]>
		> | null = null;
		if (targetId !== null) {
			nextRow = await this.members.memberInWorkspace(
				tx,
				caller.workspaceId,
				targetId,
			);
			const m = nextRow?.membership;
			const ok =
				m &&
				nextRow?.personLive &&
				m.active &&
				m.spaceId === space.id &&
				m.role !== "admin";
			if (!ok) return throwBadRequestError(SPACE_MESSAGES.HEAD_INVALID);
		}

		if (space.headMembershipId !== null) {
			await updateSpaceRow(tx, space.id, { headMembershipId: null });
			await this.members.setRole(tx, space.headMembershipId, "staff");
			await this.audit.record(tx, {
				workspaceId: caller.workspaceId,
				actorMembershipId: caller.membershipId,
				action: "role.change",
				target: `membership:${space.headMembershipId}`,
				summary: `Role head to staff in space ${space.id}`,
			});
		}
		if (targetId !== null) {
			await this.members.setRole(tx, targetId, "head");
			await this.audit.record(tx, {
				workspaceId: caller.workspaceId,
				actorMembershipId: caller.membershipId,
				action: "role.change",
				target: `membership:${targetId}`,
				summary: `Role to head in space ${space.id}`,
			});
		}
		return { next: targetId };
	};
}
