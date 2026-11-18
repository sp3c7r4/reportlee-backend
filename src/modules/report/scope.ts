import { throwNotFoundError, throwUnauthorizedError } from "@/helpers/errors";
import {
	type Caller,
	MembershipService,
} from "@/modules/membership/membership.service";
import { WORKSPACE_MESSAGES } from "@/modules/workspace/workspace.message";
import { REPORT_MESSAGES } from "./report.message";

/**
 * @info - D29: the caller for every route with no `:wsId` (E3 to E11). A non-member, a deactivated
 * member and a missing Workspace all get the same 404. A deleted or suspended person gets 401,
 * the answer `requireMembership` gives.
 */
export const resolveOrNotFound = async (
	userId: number,
	workspaceId: number,
): Promise<Caller> => {
	const members = MembershipService.getInstance();
	const caller = await members.resolve(userId, workspaceId);
	if (caller) return caller;
	if (!(await members.isLive(userId))) {
		return throwUnauthorizedError(WORKSPACE_MESSAGES.AUTH_REQUIRED);
	}
	return throwNotFoundError(REPORT_MESSAGES.NOT_FOUND);
};

/** @info - The 404 every report and period route gives when the row is not the caller's to see. */
export const notFound = (): never =>
	throwNotFoundError(REPORT_MESSAGES.NOT_FOUND);
