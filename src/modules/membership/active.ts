import { and, eq, isNull } from "drizzle-orm";
import { users } from "@/modules/user/user.model";
import { memberships } from "./membership.model";

/**
 * @info - The one definition of an ACTIVE Membership (D26): `active = true` and the person behind
 * it is neither deleted nor suspended. Last-Admin, seats, memberCount, Head candidates and the
 * roster all use this, so a Workspace whose only Admin deleted their account counts zero Admins.
 * Use it in a query that joins `users` on `memberships.user_id`.
 */
export const isActiveMember = () =>
	and(
		eq(memberships.active, true),
		isNull(users.deletedAt),
		isNull(users.suspendedAt),
	);
