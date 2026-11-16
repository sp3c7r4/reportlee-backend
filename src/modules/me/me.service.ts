import { getDb } from "@/db/postgres.db";
import { throwNotFoundError } from "@/helpers/errors";
import { setLastWorkspace } from "@/modules/membership/membership.repository";
import { MembershipService } from "@/modules/membership/membership.service";
import { WORKSPACE_MESSAGES } from "@/modules/workspace/workspace.message";

export class MeService {
	private static instance: MeService;
	private readonly membershipService = MembershipService.getInstance();

	static getInstance() {
		if (!this.instance) this.instance = new MeService();
		return this.instance;
	}

	private constructor() {}

	memberships = (userId: number) => this.membershipService.memberships(userId);

	/** @info - Ownership check: the caller must be an active member of the Workspace they pick. */
	setLastWorkspace = async (userId: number, workspaceId: number) => {
		const caller = await this.membershipService.resolve(userId, workspaceId);
		if (!caller) return throwNotFoundError(WORKSPACE_MESSAGES.NOT_FOUND);
		await getDb().transaction(async (tx) => {
			await setLastWorkspace(tx, userId, workspaceId);
		});
		return { lastWorkspaceId: String(workspaceId) };
	};
}
