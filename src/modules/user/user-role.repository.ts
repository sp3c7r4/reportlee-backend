import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { RelationalRepository } from "@/bases/repositories";
import { UserRole } from "@/enums";
import { users } from "./user.model";
import { user_roles } from "./user-role.model";

/** @info - Fixed key for pg_advisory_xact_lock: every role change queues on it. */
const ROLE_CHANGE_LOCK_KEY = 7_204_001;

export type ReplaceRoleResult =
	| { ok: true; previous: string[] }
	| { ok: false; reason: "LAST_ADMIN" };

export class UserRoleRepository extends RelationalRepository<
	typeof user_roles
> {
	private static instance: UserRoleRepository;

	static getInstance(): UserRoleRepository {
		if (!this.instance) this.instance = new UserRoleRepository();
		return this.instance;
	}

	private constructor() {
		super(user_roles);
	}

	/**
	 * @info - One role per user: delete the target's rows and insert the new one in one
	 * transaction, so the partial unique index is never violated and requireAdmin
	 * never sees two rows. The last-admin check sits INSIDE the advisory lock on
	 * purpose: two admins demoting each other at once would otherwise both pass the
	 * count and leave zero admins. Uses this._db.transaction because the private
	 * constructor drops the db argument, so the inherited transaction() would not
	 * run in a transaction.
	 */
	replaceRoleGuarded = async (
		userId: number,
		role: string,
	): Promise<ReplaceRoleResult> => {
		return this._db.transaction(async (tx) => {
			await tx.execute(
				sql`select pg_advisory_xact_lock(${ROLE_CHANGE_LOCK_KEY})`,
			);

			const current = await tx
				.select({ role: user_roles.role })
				.from(user_roles)
				.where(eq(user_roles.userId, userId));
			const previous = current.map((r) => r.role as string);

			if (previous.includes(UserRole.ADMIN) && role !== UserRole.ADMIN) {
				const [{ count }] = (await tx
					.select({ count: sql<number>`count(*)::int` })
					.from(user_roles)
					.innerJoin(users, eq(users.id, user_roles.userId))
					.where(
						and(
							eq(user_roles.role, UserRole.ADMIN),
							ne(user_roles.userId, userId),
							isNull(users.deletedAt),
							isNull(users.suspendedAt),
						),
					)) as [{ count: number }];
				if (count === 0) return { ok: false, reason: "LAST_ADMIN" } as const;
			}

			await tx.delete(user_roles).where(eq(user_roles.userId, userId));
			await tx.insert(user_roles).values({ userId, role } as any);
			return { ok: true, previous } as const;
		});
	};
}
