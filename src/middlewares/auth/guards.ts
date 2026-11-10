import { and, eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import { StatusCodes } from "http-status-codes";
import { getDb } from "@/db/postgres.db";
import { user_roles } from "@/db/postgres.schema";
import type { UserRole } from "@/enums";
import { sendErrorResponse } from "@/helpers/response/send-response";

/**
 * @info - Authorization guards. The role lives in the database, not only in the
 * token: a token minted before a role changed must not keep the old grant until it
 * expires, so every guard reads user_roles.
 */

const roleOf = async (userId: number) => {
	const db = getDb();
	const [row] = await db
		.select({ role: user_roles.role })
		.from(user_roles)
		.where(eq(user_roles.userId, userId))
		.limit(1);
	return (row?.role as UserRole | undefined) ?? null;
};

/** @info - Require email_verified = true. Apply to every route a verified person owns. */
export const requireEmailVerified = async (c: Context, next: Next) => {
	const authData = c.get("authData");
	if (!authData?.emailVerified) {
		return sendErrorResponse(
			c,
			{ message: "Email not verified. Please verify your email to continue." },
			StatusCodes.FORBIDDEN,
		);
	}
	await next();
};

/** @info - Require the caller to hold one of the given roles. */
export const requireRole =
	(...roles: UserRole[]) =>
	async (c: Context, next: Next) => {
		const authData = c.get("authData");
		if (!authData?.id) {
			return sendErrorResponse(
				c,
				{ message: "Authentication required." },
				StatusCodes.UNAUTHORIZED,
			);
		}

		const role = await roleOf(Number(authData.id));
		if (!role || !roles.includes(role)) {
			return sendErrorResponse(
				c,
				{ message: "You are not authorized to access this resource." },
				StatusCodes.FORBIDDEN,
			);
		}
		await next();
	};

/** @info - Workspace/platform admins. */
export const requireAdmin = requireRole("admin" as UserRole);

/** @info - The caller may only touch their own row (their id, not the one in the path). */
export const requireSelf = async (c: Context, next: Next) => {
	const authData = c.get("authData");
	const target = c.req.param("userId");
	if (!authData?.id || (target && String(authData.id) !== target)) {
		return sendErrorResponse(
			c,
			{ message: "You may only access your own record." },
			StatusCodes.FORBIDDEN,
		);
	}
	await next();
};

/** @info - A row belongs to the caller; used where the id is on another table. */
export const ownsRow = async (userId: number, ownerColumn: number | null) =>
	Math.abs(Number(userId)) === Math.abs(Number(ownerColumn));

/** @info - Two guards in one, for routes that need a role and a subject. */
export const requireRoleOrSelf =
	(role: UserRole) => async (c: Context, next: Next) => {
		const authData = c.get("authData");
		if (!authData?.id) {
			return sendErrorResponse(
				c,
				{ message: "Authentication required." },
				StatusCodes.UNAUTHORIZED,
			);
		}
		const target = c.req.param("userId");
		if (target && String(authData.id) === target) {
			await next();
			return;
		}
		const db = getDb();
		const [row] = await db
			.select({ role: user_roles.role })
			.from(user_roles)
			.where(
				and(
					eq(user_roles.userId, Number(authData.id)),
					eq(user_roles.role, role as string),
				),
			)
			.limit(1);
		if (!row) {
			return sendErrorResponse(
				c,
				{ message: "You are not authorized to access this resource." },
				StatusCodes.FORBIDDEN,
			);
		}
		await next();
	};
