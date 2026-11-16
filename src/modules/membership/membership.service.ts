import { getDb, getReader, type Tx } from "@/db/postgres.db";
import {
	throwBadRequestError,
	throwConflictError,
	throwNotFoundError,
	throwUnauthorizedError,
} from "@/helpers/errors";
import { AuditLogService } from "@/modules/audit/audit-log.service";
import {
	clearHeadIf,
	findSpace,
	setHeadSlot,
} from "@/modules/space/space.repository";
import { SeatService } from "@/modules/workspace/seat.service";
import {
	toMembershipDto,
	toWorkspaceDto,
} from "@/modules/workspace/workspace.dto";
import { WORKSPACE_MESSAGES } from "@/modules/workspace/workspace.message";
import {
	lockWorkspace,
	memberCounts,
} from "@/modules/workspace/workspace.repository";
import { MEMBERSHIP_MESSAGES } from "./membership.message";
import type { MembershipRole } from "./membership.model";
import {
	type Caller,
	countActiveInSpace,
	findMemberInWorkspace,
	findUserBasics,
	listActiveForUser,
	listRoster,
	lockActiveAdmins,
	resolveCaller,
	updateMembership,
} from "./membership.repository";

export type { Caller } from "./membership.repository";

/** @info - One row of the People screen. `email` is present for Admins only (P9). */
export interface RosterMemberDto {
	membershipId: string;
	name: string;
	role: string;
	space: string | null;
	spaceId: string | null;
	active: boolean;
	joinedAt: string;
	email?: string;
}

const toRosterDto = (
	r: Awaited<ReturnType<typeof listRoster>>[number],
	withEmail: boolean,
): RosterMemberDto => ({
	membershipId: String(r.membership.id),
	name: `${r.firstName} ${r.lastName}`.trim(),
	role: r.membership.role,
	space: r.spaceName,
	spaceId: r.membership.spaceId === null ? null : String(r.membership.spaceId),
	/* @info - A deleted or suspended person is not active, whatever the Membership flag says (D26). */
	active: r.membership.active && r.personLive,
	joinedAt: r.membership.joinedAt.toISOString(),
	...(withEmail && { email: r.email }),
});

export class MembershipService {
	private static instance: MembershipService;
	private readonly audit = AuditLogService.getInstance();
	private readonly seats = SeatService.getInstance();

	static getInstance() {
		if (!this.instance) this.instance = new MembershipService();
		return this.instance;
	}

	private constructor() {}

	/**
	 * @info - THE choke point (D4): who is this person in this Workspace. Reads the database on
	 * every call, so a deactivation takes effect at once. Role and Space never come from a token,
	 * body or query. Returns null for a non-member, a deactivated member and a missing Workspace
	 * alike, so a caller cannot tell them apart (D5).
	 */
	resolve = async (
		userId: number,
		workspaceId: number,
	): Promise<Caller | null> => resolveCaller(getReader(), userId, workspaceId);

	/* @info - Transaction-scoped helpers other modules call instead of reaching into this repository. */
	memberInWorkspace = (tx: Tx, workspaceId: number, membershipId: number) =>
		findMemberInWorkspace(tx, workspaceId, membershipId);

	setRole = (tx: Tx, membershipId: number, role: MembershipRole) =>
		updateMembership(tx, membershipId, { role });

	activeCountInSpace = (tx: Tx, spaceId: number) =>
		countActiveInSpace(tx, spaceId);

	/**
	 * @info - Roster (P9): every member sees active people with name, role and Space. Only an Admin
	 * sees email addresses and deactivated people.
	 */
	roster = async (caller: Caller): Promise<RosterMemberDto[]> => {
		const isAdmin = caller.role === "admin";
		const rows = await listRoster(getReader(), caller.workspaceId, isAdmin);
		return rows.map((r) => toRosterDto(r, isAdmin));
	};

	/**
	 * @info - D6: refuses to leave a Workspace without an active Admin. Call inside the Workspace
	 * lock. The Admin rows are locked FOR UPDATE, so two simultaneous demotions serialise (AC5).
	 */
	assertNotLastAdmin = async (
		tx: Tx,
		workspaceId: number,
		membershipId: number,
	) => {
		const admins = await lockActiveAdmins(tx, workspaceId);
		if (!admins.some((a) => a.id !== membershipId)) {
			return throwConflictError(MEMBERSHIP_MESSAGES.LAST_ADMIN);
		}
	};

	/** @info - Admin only (route guard). The rules are in design.md, "Member change rules". */
	updateMember = async (
		caller: Caller,
		membershipId: number,
		body: { role?: MembershipRole; spaceId?: string | null; active?: boolean },
	): Promise<RosterMemberDto> =>
		getDb().transaction(async (tx) => {
			const workspace = await lockWorkspace(tx, caller.workspaceId);
			if (!workspace) return throwNotFoundError(WORKSPACE_MESSAGES.NOT_FOUND);
			const found = await findMemberInWorkspace(
				tx,
				caller.workspaceId,
				membershipId,
			);
			if (!found) return throwNotFoundError(MEMBERSHIP_MESSAGES.NOT_FOUND);
			const cur = found.membership;

			const nextRole = body.role ?? cur.role;
			const nextActive = body.active ?? cur.active;
			let nextSpaceId: number | null =
				body.spaceId === undefined
					? cur.spaceId
					: body.spaceId === null
						? null
						: Number(body.spaceId);

			/* @info - Rules 1 to 3: Admin has no Space, everyone else has an active one in this Workspace. */
			if (nextRole === "admin") {
				if (body.spaceId !== undefined && body.spaceId !== null) {
					return throwBadRequestError(MEMBERSHIP_MESSAGES.ADMIN_NO_SPACE);
				}
				nextSpaceId = null;
			} else if (nextSpaceId === null) {
				return throwBadRequestError(MEMBERSHIP_MESSAGES.SPACE_REQUIRED);
			}
			let space: Awaited<ReturnType<typeof findSpace>> = null;
			if (nextSpaceId !== null) {
				space = await findSpace(tx, caller.workspaceId, nextSpaceId);
				if (nextSpaceId !== cur.spaceId && (!space || space.archivedAt)) {
					return throwBadRequestError(MEMBERSHIP_MESSAGES.SPACE_INVALID);
				}
			}

			/* @info - Rules 4 and 5: one Head per Space, and a Head cannot walk to another Space. */
			if (
				cur.role === "head" &&
				nextRole === "head" &&
				nextSpaceId !== cur.spaceId
			) {
				return throwConflictError(MEMBERSHIP_MESSAGES.HEAD_CANNOT_MOVE);
			}
			if (nextRole === "head") {
				/* @info - Only a NEW Head must be active. Deactivating a current Head keeps the role and frees the slot. */
				if (!nextActive && cur.role !== "head") {
					return throwBadRequestError(MEMBERSHIP_MESSAGES.HEAD_NEEDS_ACTIVE);
				}
				if (
					nextActive &&
					space &&
					space.headMembershipId !== null &&
					space.headMembershipId !== cur.id
				) {
					return throwConflictError(MEMBERSHIP_MESSAGES.HEAD_EXISTS);
				}
			}

			/* @info - Rule 6: counted per D26, so a deleted Admin does not count. */
			const wasActiveAdmin =
				cur.role === "admin" && cur.active && found.personLive;
			const staysActiveAdmin =
				nextRole === "admin" && nextActive && found.personLive;
			if (wasActiveAdmin && !staysActiveAdmin) {
				await this.assertNotLastAdmin(tx, caller.workspaceId, cur.id);
			}

			/* @info - Rule 7: reactivation takes a seat. */
			if (!cur.active && nextActive) {
				await this.seats.assertSeat(tx, workspace, 1);
			}

			/* @info - Rule 5, second half: leaving the Head role, or being deactivated, frees the slot. */
			const wasHead = cur.role === "head" && cur.spaceId !== null;
			if (wasHead && (nextRole !== "head" || !nextActive)) {
				await clearHeadIf(tx, cur.spaceId as number, cur.id);
			}

			const values: Parameters<typeof updateMembership>[2] = {};
			if (nextRole !== cur.role) values.role = nextRole;
			if (nextSpaceId !== cur.spaceId) values.spaceId = nextSpaceId;
			if (nextActive !== cur.active) values.active = nextActive;
			if (Object.keys(values).length > 0) {
				await updateMembership(tx, cur.id, values);
			}
			if (
				nextRole === "head" &&
				nextActive &&
				space &&
				space.headMembershipId !== cur.id
			) {
				await setHeadSlot(tx, space.id, cur.id);
			}

			if (values.role !== undefined || values.spaceId !== undefined) {
				await this.audit.record(tx, {
					workspaceId: caller.workspaceId,
					actorMembershipId: caller.membershipId,
					action: "role.change",
					target: `membership:${cur.id}`,
					summary: `Role ${cur.role} to ${nextRole}, space ${cur.spaceId ?? "none"} to ${nextSpaceId ?? "none"}`,
				});
			}
			if (values.active !== undefined) {
				await this.audit.record(tx, {
					workspaceId: caller.workspaceId,
					actorMembershipId: caller.membershipId,
					action: nextActive ? "member.reactivated" : "member.deactivated",
					target: `membership:${cur.id}`,
					summary: `Membership ${cur.id} ${nextActive ? "reactivated" : "deactivated"}`,
				});
			}

			const rows = await listRoster(tx, caller.workspaceId, true);
			const row = rows.find((r) => r.membership.id === cur.id);
			if (!row) return throwNotFoundError(MEMBERSHIP_MESSAGES.NOT_FOUND);
			return toRosterDto(row, true);
		});

	/** @info - False for a deleted or suspended person: their session must be refused with a 401. */
	isLive = async (userId: number): Promise<boolean> =>
		Boolean(await findUserBasics(getReader(), userId));

	/** @info - Response of GET /me/memberships. */
	memberships = async (userId: number) => {
		const db = getReader();
		const [user, rows] = await Promise.all([
			findUserBasics(db, userId),
			listActiveForUser(db, userId),
		]);
		if (!user) return throwUnauthorizedError(WORKSPACE_MESSAGES.AUTH_REQUIRED);
		const counts = await memberCounts(
			db,
			rows.map((r) => r.workspace.id),
		);
		const lastWorkspaceId =
			user?.lastWorkspaceId &&
			rows.some((r) => r.workspace.id === user.lastWorkspaceId)
				? String(user.lastWorkspaceId)
				: null;
		return {
			user: {
				id: String(userId),
				name: `${user?.firstName ?? ""} ${user?.lastName ?? ""}`.trim(),
				email: user?.email ?? "",
			},
			memberships: rows.map((r) => toMembershipDto(r.membership, r.spaceName)),
			workspaces: rows.map((r) =>
				toWorkspaceDto(r.workspace, counts.get(r.workspace.id) ?? 0),
			),
			lastWorkspaceId,
		};
	};
}
