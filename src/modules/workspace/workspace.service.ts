import { RESERVED_SLUGS, SLUG_PATTERN } from "@/constants/reserved-slugs";
import { getDb, getReader } from "@/db/postgres.db";
import { throwConflictError, throwNotFoundError } from "@/helpers/errors";
import { isUniqueViolation } from "@/helpers/pg-error";
import { AuditLogService } from "@/modules/audit/audit-log.service";
import {
	insertMembership,
	setLastWorkspace,
} from "@/modules/membership/membership.repository";
import type { Caller } from "@/modules/membership/membership.service";
import { UserService } from "@/modules/user/user.service";
import { toMembershipDto, toWorkspaceDto } from "./workspace.dto";
import { WORKSPACE_MESSAGES } from "./workspace.message";
import {
	findWorkspace,
	insertWorkspace,
	lockWorkspace,
	memberCounts,
	slugExists,
	updateWorkspace,
} from "./workspace.repository";

export class WorkspaceService {
	private static instance: WorkspaceService;
	private readonly audit = AuditLogService.getInstance();
	private readonly userService = UserService.getInstance();

	static getInstance() {
		if (!this.instance) this.instance = new WorkspaceService();
		return this.instance;
	}

	private constructor() {}

	/** @info - Answers the debounced check on the onboarding form. Format and reserved first, then the database. */
	slugAvailable = async (slug: string) => {
		const value = slug.trim().toLowerCase();
		if (value.length < 3 || value.length > 32 || !SLUG_PATTERN.test(value)) {
			return { available: false, reason: "invalid" as const };
		}
		if (RESERVED_SLUGS.includes(value)) {
			return { available: false, reason: "reserved" as const };
		}
		if (await slugExists(getReader(), value)) {
			return { available: false, reason: "taken" as const };
		}
		return { available: true };
	};

	/**
	 * @info - One transaction: Workspace, Admin Membership, audit row, last Workspace (AC1). Needs a
	 * verified email read from the user row, not from the cached session (D25).
	 */
	create = async (
		userId: number,
		body: { name: string; slug: string; timeZone?: string },
	) => {
		await this.userService.assertVerified(userId);
		const slug = body.slug.toLowerCase();
		if (await slugExists(getReader(), slug)) {
			return throwConflictError(WORKSPACE_MESSAGES.SLUG_TAKEN);
		}
		try {
			return await getDb().transaction(async (tx) => {
				const workspace = await insertWorkspace(tx, {
					name: body.name,
					slug,
					timeZone: body.timeZone ?? "UTC",
					createdBy: userId,
				});
				const membership = await insertMembership(tx, {
					userId,
					workspaceId: workspace.id,
					role: "admin",
					spaceId: null,
				});
				await this.audit.record(tx, {
					workspaceId: workspace.id,
					actorMembershipId: membership.id,
					action: "workspace.created",
					target: `workspace:${workspace.id}`,
					summary: `Workspace ${workspace.id} created`,
				});
				await setLastWorkspace(tx, userId, workspace.id);
				return {
					workspace: toWorkspaceDto(workspace, 1),
					membership: toMembershipDto(membership, null),
				};
			});
		} catch (error) {
			/* @info - Two people choosing one slug at once: the unique index decides. */
			if (isUniqueViolation(error)) {
				return throwConflictError(WORKSPACE_MESSAGES.SLUG_TAKEN);
			}
			throw error;
		}
	};

	get = async (workspaceId: number) => {
		const db = getReader();
		const row = await findWorkspace(db, workspaceId);
		if (!row) return throwNotFoundError(WORKSPACE_MESSAGES.NOT_FOUND);
		const counts = await memberCounts(db, [workspaceId]);
		return toWorkspaceDto(row, counts.get(workspaceId) ?? 0);
	};

	update = async (
		caller: Caller,
		body: { name?: string; timeZone?: string; locationTagging?: boolean },
	) =>
		getDb().transaction(async (tx) => {
			const locked = await lockWorkspace(tx, caller.workspaceId);
			if (!locked) return throwNotFoundError(WORKSPACE_MESSAGES.NOT_FOUND);
			const row = await updateWorkspace(tx, caller.workspaceId, body);
			await this.audit.record(tx, {
				workspaceId: caller.workspaceId,
				actorMembershipId: caller.membershipId,
				action: "workspace.updated",
				target: `workspace:${caller.workspaceId}`,
				summary: `Changed: ${Object.keys(body).join(", ")}`,
			});
			const counts = await memberCounts(tx, [caller.workspaceId]);
			return toWorkspaceDto(row, counts.get(caller.workspaceId) ?? 0);
		});
}
