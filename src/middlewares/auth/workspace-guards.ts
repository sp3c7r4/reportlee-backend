import type { Context, Next } from "hono";
import {
	throwForbiddenError,
	throwNotFoundError,
	throwUnauthorizedError,
} from "@/helpers/errors";
import type { MembershipRole } from "@/modules/membership/membership.model";
import { MembershipService } from "@/modules/membership/membership.service";
import { WORKSPACE_MESSAGES } from "@/modules/workspace/workspace.message";

/**
 * @info - Workspace guards (D4, D5, D24). They never read `user_roles`: that table holds the
 * platform role, and a platform Admin has no access to a Workspace without a Membership.
 */

/**
 * @info - The caller's user id, read from the one field `guards.ts` also reads. `IAuthData` does not
 * declare `id`, so it is read here, in one place, and a missing or malformed id is a 401.
 */
export const callerId = (c: Context): number => {
	const raw = c.get("authData")?.id;
	const id = Number(raw);
	if (raw === undefined || raw === null || !Number.isInteger(id) || id <= 0) {
		return throwUnauthorizedError(WORKSPACE_MESSAGES.AUTH_REQUIRED);
	}
	return id;
};

/** @info - 401 when the session has no usable user id. Runs before parameter validation. */
export const requireCaller = async (c: Context, next: Next) => {
	callerId(c);
	await next();
};

/**
 * @info - Resolves the caller in `:wsId` and stores it as `caller` on the context. A non-member,
 * a deactivated member and a missing Workspace all get the same 404.
 */
export const requireMembership = async (c: Context, next: Next) => {
	const userId = callerId(c);
	const workspaceId = Number(c.req.param("wsId"));
	const caller = await MembershipService.getInstance().resolve(
		userId,
		workspaceId,
	);
	if (!caller) {
		/* @info - A deleted or suspended person is not a "not a member" case: their session is over. */
		if (!(await MembershipService.getInstance().isLive(userId))) {
			return throwUnauthorizedError(WORKSPACE_MESSAGES.AUTH_REQUIRED);
		}
		return throwNotFoundError(WORKSPACE_MESSAGES.NOT_FOUND);
	}
	c.set("caller", caller);
	await next();
};

/** @info - Coarse role gate. Runs after requireMembership. The service still checks ownership. */
export const requireWorkspaceRole =
	(...roles: MembershipRole[]) =>
	async (c: Context, next: Next) => {
		const caller = c.get("caller");
		if (!caller || !roles.includes(caller.role)) {
			return throwForbiddenError(WORKSPACE_MESSAGES.FORBIDDEN);
		}
		await next();
	};
