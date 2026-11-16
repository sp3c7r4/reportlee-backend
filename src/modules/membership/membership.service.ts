import { getReader, type Tx } from "@/db/postgres.db";
import { throwUnauthorizedError } from "@/helpers/errors";
import {
	toMembershipDto,
	toWorkspaceDto,
} from "@/modules/workspace/workspace.dto";
import { WORKSPACE_MESSAGES } from "@/modules/workspace/workspace.message";
import { memberCounts } from "@/modules/workspace/workspace.repository";
import type { MembershipRole } from "./membership.model";
import {
	type Caller,
	countActiveInSpace,
	findMemberInWorkspace,
	findUserBasics,
	listActiveForUser,
	resolveCaller,
	updateMembership,
} from "./membership.repository";

export type { Caller } from "./membership.repository";

export class MembershipService {
	private static instance: MembershipService;

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
