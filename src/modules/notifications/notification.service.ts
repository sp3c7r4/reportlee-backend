import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import type { NotificationType } from "@/enums";
import { user_roles } from "@/modules/user/user-role.model";
import { PubSubService } from "@/services/pubsub.service";
import { serviceLogger } from "@/utils";
import { type NewNotification, notifications } from "./notification.model";

/** @info - User notifications: any module calls notify(); the owner reads them
 * over the API, and an open socket receives the new one immediately. */
export class NotificationService {
	private static instance: NotificationService;
	private readonly log = serviceLogger("Notifications");

	static getInstance(): NotificationService {
		if (!this.instance) this.instance = new NotificationService();
		return this.instance;
	}

	private constructor() {}

	/** @info - Fire-and-forget create. Resolves the recipient's primary role
	 * for the role column; failures are logged, never thrown to the caller. */
	notify = async (
		userId: number,
		type: NotificationType,
		title: string,
		message: string,
		metadata?: Record<string, unknown>,
		/* @info - Added by the review slice (D16), optional so existing callers are unchanged. */
		extra?: { workspaceId?: number; membershipId?: number; href?: string },
	): Promise<void> => {
		try {
			const db = getDb();
			const [roleRow] = await db
				.select({ role: user_roles.role })
				.from(user_roles)
				.where(eq(user_roles.userId, userId))
				.limit(1);

			const data: NewNotification = {
				userId,
				role: (roleRow?.role as any) ?? "member",
				type: type as any,
				title,
				message,
				metadata: (metadata ?? {}) as any,
				workspaceId: extra?.workspaceId ?? null,
				membershipId: extra?.membershipId ?? null,
				href: extra?.href ?? null,
			};
			const [row] = (await db
				.insert(notifications)
				.values(data as any)
				.returning()) as any[];

			/* @info - Realtime push over the same Redis channel an open socket is
			 * already subscribed to; the client's poll is only the fallback. */
			if (row) {
				await PubSubService.getInstance().publishUser(userId, {
					timestamp: new Date().toISOString(),
					status: 200,
					success: true,
					data: {
						type: "notification:new",
						payload: {
							id: row.id,
							type: row.type,
							title: row.title,
							message: row.message,
							metadata: row.metadata ?? {},
							read: false,
							createdAt: row.createdAt,
							workspaceId:
								row.workspaceId === null || row.workspaceId === undefined
									? null
									: String(row.workspaceId),
							href: row.href ?? null,
						},
					},
				});
			}
		} catch (error) {
			this.log.error(
				`Failed to notify user ${userId}: ${(error as Error).message}`,
			);
		}
	};

	/** @info - The caller's rows, in one Workspace when `workspaceId` is given (rows written before
	 * 0003 have none and show only without the filter). */
	private mine = (userId: number, workspaceId?: number) =>
		workspaceId === undefined
			? eq(notifications.userId, userId)
			: and(
					eq(notifications.userId, userId),
					eq(notifications.workspaceId, workspaceId),
				);

	listMine = async (
		userId: number,
		params?: { page?: number; limit?: number; workspaceId?: number },
	) => {
		const db = getDb();
		const page = Math.max(1, params?.page ?? 1);
		const limit = Math.min(50, Math.max(1, params?.limit ?? 20));
		const where = this.mine(userId, params?.workspaceId);

		const [rows, totalRows] = await Promise.all([
			db
				.select()
				.from(notifications)
				.where(where)
				.orderBy(desc(notifications.createdAt), desc(notifications.id))
				.limit(limit)
				.offset((page - 1) * limit) as any,
			db
				.select({ total: notifications.id })
				.from(notifications)
				.where(where) as any,
		]);

		return {
			data: (rows as any[]).map((n) => ({
				id: n.id,
				type: n.type,
				title: n.title,
				message: n.message,
				metadata: n.metadata ?? {},
				read: !!n.readAt,
				createdAt: n.createdAt,
				workspaceId: n.workspaceId === null ? null : String(n.workspaceId),
				href: n.href ?? null,
			})),
			total: totalRows.length,
			page,
			limit,
		};
	};

	unreadCount = async (userId: number, workspaceId?: number) => {
		const db = getDb();
		const rows = (await db
			.select({ id: notifications.id })
			.from(notifications)
			.where(
				and(this.mine(userId, workspaceId), isNull(notifications.readAt)),
			)) as any[];
		return rows.length;
	};

	markRead = async (userId: number, id: number) => {
		const db = getDb();
		const [row] = (await db
			.update(notifications)
			.set({ readAt: new Date() })
			.where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
			.returning()) as any[];
		return !!row;
	};

	markAllRead = async (userId: number, workspaceId?: number) => {
		const db = getDb();
		await db
			.update(notifications)
			.set({ readAt: new Date() })
			.where(and(this.mine(userId, workspaceId), isNull(notifications.readAt)));
	};
}
