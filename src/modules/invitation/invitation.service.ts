import { createHash, randomBytes } from "node:crypto";
import { config } from "@/config";
import {
	INVITE_DAILY_LIMIT_PER_WORKSPACE,
	INVITE_DAILY_LIMIT_PLATFORM,
} from "@/constants";
import { getDb, getReader, type Tx } from "@/db/postgres.db";
import { EmailJobNames, EmailTemplates } from "@/enums";
import { CodedForbiddenError, CodedRateLimitError } from "@/errors";
import {
	throwBadRequestError,
	throwConflictError,
	throwForbiddenError,
	throwNotFoundError,
} from "@/helpers/errors";
import { AuditLogService } from "@/modules/audit/audit-log.service";
import { setLastWorkspace } from "@/modules/membership/membership.repository";
import {
	type Caller,
	MembershipService,
} from "@/modules/membership/membership.service";
import { findSpace, setHeadSlot } from "@/modules/space/space.repository";
import { UserService } from "@/modules/user/user.service";
import { SeatService } from "@/modules/workspace/seat.service";
import {
	toMembershipDto,
	toWorkspaceDto,
} from "@/modules/workspace/workspace.dto";
import { WORKSPACE_MESSAGES } from "@/modules/workspace/workspace.message";
import {
	findWorkspace,
	lockWorkspace,
	memberCounts,
} from "@/modules/workspace/workspace.repository";
import { EmailQueueService } from "@/services/queues/email.queue.service";
import { logger } from "@/utils";
import {
	INVITATION_MESSAGES,
	INVITE_DAILY_LIMIT_CODE,
	INVITE_EMAIL_MISMATCH_CODE,
	INVITE_EXPIRY_DAYS,
	INVITE_PLATFORM_LIMIT_CODE,
} from "./invitation.message";
import type { Invitation } from "./invitation.model";
import {
	acceptIfPending,
	countCreatedLast24h,
	findByTokenHash,
	findInWorkspace,
	findMemberByEmail,
	insertInvitation,
	listByIds,
	listPending,
	lockInvitePlatform,
	pendingForEmail,
	pendingHeadInviteForSpace,
	revokeIfPending,
	sweepExpired,
} from "./invitation.repository";

type Role = "staff" | "head" | "admin";

export interface InvitationDto {
	id: string;
	email: string;
	role: string;
	space: string | null;
	spaceId: string | null;
	sentAt: string;
	invitedByMembershipId: string;
	expired: boolean;
}

export interface InvitationInput {
	email: string;
	role: Role;
	spaceId?: string | null;
}

const hashToken = (token: string) =>
	createHash("sha256").update(token).digest("hex");

/** @info - "ada@example.com" becomes "a***@example.com". The full address is never echoed to a stranger. */
export const maskEmail = (email: string) => {
	const [local = "", domain = ""] = email.split("@");
	return `${local.slice(0, 1)}***@${domain}`;
};

const toDto = (
	row: Invitation,
	spaceName: string | null,
	expired: boolean,
): InvitationDto => ({
	id: String(row.id),
	email: row.email,
	role: row.role,
	space: spaceName,
	spaceId: row.spaceId === null ? null : String(row.spaceId),
	sentAt: row.createdAt.toISOString(),
	invitedByMembershipId: String(row.invitedByMembershipId),
	expired,
});

export class InvitationService {
	private static instance: InvitationService;
	private readonly audit = AuditLogService.getInstance();
	private readonly members = MembershipService.getInstance();
	private readonly seats = SeatService.getInstance();
	private readonly users = UserService.getInstance();

	static getInstance() {
		if (!this.instance) this.instance = new InvitationService();
		return this.instance;
	}

	private constructor() {}

	/**
	 * @info - Port of `inviteRules` in the frontend's people.ts. Admin: any role, a Space for Staff
	 * and Head, none for Admin. Head: Staff only, into their own Space. Staff: never. Returns the
	 * Space id the row will carry.
	 */
	assertCanInvite = (
		caller: Caller,
		role: Role,
		spaceId: number | null,
	): number | null => {
		if (caller.role === "staff") {
			return throwForbiddenError(WORKSPACE_MESSAGES.FORBIDDEN);
		}
		if (caller.role === "head") {
			if (role !== "staff") {
				return throwForbiddenError(WORKSPACE_MESSAGES.FORBIDDEN);
			}
			if (spaceId !== null && spaceId !== caller.spaceId) {
				return throwForbiddenError(WORKSPACE_MESSAGES.FORBIDDEN);
			}
			return caller.spaceId;
		}
		return spaceId;
	};

	create = async (
		caller: Caller,
		rows: InvitationInput[],
	): Promise<Array<InvitationDto & { inviteUrl: string }>> => {
		const issued = await getDb().transaction(async (tx) => {
			const workspace = await lockWorkspace(tx, caller.workspaceId);
			if (!workspace) return throwNotFoundError(WORKSPACE_MESSAGES.NOT_FOUND);
			await sweepExpired(tx, caller.workspaceId);

			/* @info - Check every row first, so a failure creates nothing. */
			const checked: Array<{ input: InvitationInput; spaceId: number | null }> =
				[];
			for (const input of rows) {
				const wanted =
					input.spaceId === undefined || input.spaceId === null
						? null
						: Number(input.spaceId);
				const spaceId = this.assertCanInvite(caller, input.role, wanted);
				await this.checkRow(
					tx,
					caller.workspaceId,
					input.email,
					input.role,
					spaceId,
				);
				checked.push({ input, spaceId });
			}
			await this.assertDailyLimits(tx, caller.workspaceId, rows.length);
			await this.seats.assertSeat(tx, workspace, rows.length);

			const out: Array<{ row: Invitation; token: string }> = [];
			for (const { input, spaceId } of checked) {
				const token = randomBytes(32).toString("base64url");
				const row = await insertInvitation(tx, {
					workspaceId: caller.workspaceId,
					email: input.email,
					role: input.role,
					spaceId,
					tokenHash: hashToken(token),
					invitedByMembershipId: caller.membershipId,
				});
				await this.audit.record(tx, {
					workspaceId: caller.workspaceId,
					actorMembershipId: caller.membershipId,
					action: "invitation.sent",
					target: `invitation:${row.id}`,
					summary: `Invitation ${row.id} sent for role ${input.role}`,
				});
				out.push({ row, token });
			}
			const dtoRows = await listByIds(
				tx,
				out.map((o) => o.row.id),
			);
			return { out, workspaceName: workspace.name, dtoRows };
		});

		const result = issued.out.map(({ row, token }) => {
			const joined = issued.dtoRows.find((d) => d.invitation.id === row.id);
			return {
				...toDto(row, joined?.spaceName ?? null, false),
				inviteUrl: `${config.frontendUrl}/invite/${token}`,
			};
		});

		/* @info - After commit. The link is also in the job data, so the job is removed on success
		 * and kept at most 24 hours after a failure. A queue failure never fails the request. */
		for (const [index, { row }] of issued.out.entries()) {
			const entry = result[index];
			if (!entry) continue;
			try {
				await EmailQueueService.getInstance().add(
					EmailJobNames.INVITATION as never,
					{
						message: {
							to: row.email,
							subject: INVITATION_MESSAGES.subject(issued.workspaceName),
						},
						template: EmailTemplates.INVITATION,
						locals: {
							workspaceName: issued.workspaceName,
							role: row.role,
							inviteUrl: entry.inviteUrl,
							expiresInDays: INVITE_EXPIRY_DAYS,
						},
						idempotencyKey: `invitation:${row.id}`,
					},
					{ removeOnComplete: true, removeOnFail: { age: 86400 } },
				);
			} catch {
				logger.warn(`Invitation email not queued for invitation ${row.id}`);
			}
		}
		return result;
	};

	/**
	 * @info - Call inside the Workspace lock. The platform lock is taken here, after it, so two
	 * creates in different Workspaces cannot both spend the last platform invitation. A batch that
	 * would cross a limit is refused whole: nothing is written or queued, no seat is taken.
	 */
	private assertDailyLimits = async (
		tx: Tx,
		workspaceId: number,
		batch: number,
	) => {
		const forWorkspace = await countCreatedLast24h(tx, workspaceId);
		if (forWorkspace + batch > INVITE_DAILY_LIMIT_PER_WORKSPACE) {
			throw new CodedRateLimitError(
				INVITATION_MESSAGES.DAILY_LIMIT,
				INVITE_DAILY_LIMIT_CODE,
			);
		}
		await lockInvitePlatform(tx);
		const forPlatform = await countCreatedLast24h(tx, null);
		if (forPlatform + batch > INVITE_DAILY_LIMIT_PLATFORM) {
			throw new CodedRateLimitError(
				INVITATION_MESSAGES.PLATFORM_LIMIT,
				INVITE_PLATFORM_LIMIT_CODE,
			);
		}
	};

	/** @info - Rules 3 and 4 of "Invitation create rules". Nothing is written. */
	private checkRow = async (
		tx: Tx,
		workspaceId: number,
		email: string,
		role: Role,
		spaceId: number | null,
	) => {
		if (role === "admin" && spaceId !== null) {
			return throwBadRequestError(INVITATION_MESSAGES.ADMIN_NO_SPACE);
		}
		if (role !== "admin" && spaceId === null) {
			return throwBadRequestError(INVITATION_MESSAGES.SPACE_REQUIRED);
		}
		let space: Awaited<ReturnType<typeof findSpace>> = null;
		if (spaceId !== null) {
			space = await findSpace(tx, workspaceId, spaceId);
			if (!space || space.archivedAt) {
				return throwBadRequestError(INVITATION_MESSAGES.SPACE_INVALID);
			}
		}
		const member = await findMemberByEmail(tx, workspaceId, email);
		if (member) {
			return throwConflictError(
				member.active && member.personLive
					? INVITATION_MESSAGES.ALREADY_MEMBER_OR_PENDING
					: INVITATION_MESSAGES.DEACTIVATED_MEMBER,
			);
		}
		if (await pendingForEmail(tx, workspaceId, email)) {
			return throwConflictError(INVITATION_MESSAGES.ALREADY_MEMBER_OR_PENDING);
		}
		if (role === "head" && space) {
			if (space.headMembershipId !== null) {
				return throwConflictError(INVITATION_MESSAGES.HEAD_EXISTS);
			}
			if (await pendingHeadInviteForSpace(tx, space.id)) {
				return throwConflictError(INVITATION_MESSAGES.HEAD_PENDING);
			}
		}
	};

	/** @info - Admin sees every pending row. A Head sees rows for their own Space only. Staff never get here. */
	list = async (caller: Caller): Promise<InvitationDto[]> => {
		const rows = await listPending(
			getReader(),
			caller.workspaceId,
			caller.role === "head" ? caller.spaceId : null,
		);
		return rows.map((r) => toDto(r.invitation, r.spaceName, r.expired));
	};

	/** @info - Admin, or the person who sent it. A pending row past `expires_at` can still be revoked (AC20). */
	revoke = async (caller: Caller, invitationId: number) =>
		getDb().transaction(async (tx) => {
			const row = await findInWorkspace(tx, caller.workspaceId, invitationId);
			if (row?.status !== "pending") {
				return throwNotFoundError(INVITATION_MESSAGES.NOT_FOUND);
			}
			const owns = row.invitedByMembershipId === caller.membershipId;
			if (caller.role !== "admin" && !owns) {
				return throwForbiddenError(WORKSPACE_MESSAGES.FORBIDDEN);
			}
			if (!(await revokeIfPending(tx, row.id))) {
				return throwNotFoundError(INVITATION_MESSAGES.NOT_FOUND);
			}
			await this.audit.record(tx, {
				workspaceId: caller.workspaceId,
				actorMembershipId: caller.membershipId,
				action: "invitation.revoked",
				target: `invitation:${row.id}`,
				summary: `Invitation ${row.id} revoked`,
			});
			return { id: String(row.id), status: "revoked" as const };
		});

	preview = async (userId: number, token: string) => {
		const email = await this.users.assertVerified(userId);
		const found = await findByTokenHash(getReader(), hashToken(token));
		if (
			!found ||
			found.workspace.deletedAt ||
			found.invitation.status !== "pending" ||
			found.expired
		) {
			return throwNotFoundError(INVITATION_MESSAGES.INVALID);
		}
		this.assertEmailMatches(found.invitation.email, email);
		return {
			workspaceName: found.workspace.name,
			role: found.invitation.role,
			spaceName: found.spaceName,
			email: maskEmail(found.invitation.email),
		};
	};

	private assertEmailMatches = (invited: string, verified: string) => {
		if (invited.toLowerCase() !== verified.toLowerCase()) {
			throw new CodedForbiddenError(
				INVITATION_MESSAGES.mismatch(maskEmail(invited)),
				INVITE_EMAIL_MISMATCH_CODE,
			);
		}
	};

	/** @info - Steps (a) to (e) of "Invitation accept rules", in that order. */
	accept = async (userId: number, token: string) => {
		const email = await this.users.assertVerified(userId);
		const hash = hashToken(token);
		const found = await findByTokenHash(getReader(), hash);
		if (!found || found.workspace.deletedAt) {
			return throwNotFoundError(INVITATION_MESSAGES.INVALID);
		}
		const invitation = found.invitation;

		/* @info - (b) the same person accepting again gets the same answer, if still a member. */
		if (
			invitation.status === "accepted" &&
			invitation.acceptedByUserId === userId
		) {
			const existing = await this.members.byUser(
				getReader(),
				invitation.workspaceId,
				userId,
			);
			if (existing?.active) {
				return this.accepted(
					getReader(),
					invitation.workspaceId,
					existing,
					found.spaceName,
				);
			}
			return throwConflictError(INVITATION_MESSAGES.ACCESS_TURNED_OFF);
		}
		/* @info - (c) */
		if (invitation.status !== "pending" || found.expired) {
			return throwNotFoundError(INVITATION_MESSAGES.INVALID);
		}
		/* @info - (d) */
		this.assertEmailMatches(invitation.email, email);

		/* @info - (e) one transaction under the Workspace lock. */
		return getDb().transaction(async (tx) => {
			const workspace = await lockWorkspace(tx, invitation.workspaceId);
			if (!workspace) return throwNotFoundError(INVITATION_MESSAGES.INVALID);

			const existing = await this.members.byUser(tx, workspace.id, userId);
			if (existing) {
				return throwConflictError(
					existing.active
						? INVITATION_MESSAGES.YOU_ALREADY_BELONG
						: INVITATION_MESSAGES.ACCESS_TURNED_OFF,
				);
			}
			let space: Awaited<ReturnType<typeof findSpace>> = null;
			if (invitation.spaceId !== null) {
				space = await findSpace(tx, workspace.id, invitation.spaceId);
				if (!space || space.archivedAt) {
					return throwConflictError(INVITATION_MESSAGES.SPACE_ARCHIVED);
				}
				if (invitation.role === "head" && space.headMembershipId !== null) {
					return throwConflictError(INVITATION_MESSAGES.HEAD_EXISTS);
				}
			}
			/* @info - D21: the pending invitation already holds the seat, so no seat check here. */
			if (!(await acceptIfPending(tx, invitation.id, userId))) {
				return throwNotFoundError(INVITATION_MESSAGES.INVALID);
			}
			const membership = await this.members.insert(tx, {
				userId,
				workspaceId: workspace.id,
				role: invitation.role,
				spaceId: invitation.spaceId,
			});
			if (invitation.role === "head" && space) {
				await setHeadSlot(tx, space.id, membership.id);
			}
			await setLastWorkspace(tx, userId, workspace.id);
			await this.audit.record(tx, {
				workspaceId: workspace.id,
				actorMembershipId: membership.id,
				action: "member.joined",
				target: `membership:${membership.id}`,
				summary: `Membership ${membership.id} joined as ${invitation.role}`,
			});
			return this.accepted(tx, workspace.id, membership, space?.name ?? null);
		});
	};

	private accepted = async (
		tx: Tx,
		workspaceId: number,
		membership: Parameters<typeof toMembershipDto>[0],
		spaceName: string | null,
	) => {
		const workspace = await findWorkspace(tx, workspaceId);
		if (!workspace) return throwNotFoundError(INVITATION_MESSAGES.INVALID);
		const counts = await memberCounts(tx, [workspaceId]);
		return {
			membership: toMembershipDto(membership, spaceName),
			workspace: toWorkspaceDto(workspace, counts.get(workspaceId) ?? 0),
		};
	};
}
