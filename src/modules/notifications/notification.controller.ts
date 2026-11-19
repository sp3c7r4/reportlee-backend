import type { Context } from "hono";
import { FieldError } from "@/errors";
import { sendSuccessResponse } from "@/helpers";
import { NotificationService } from "./notification.service";

/* @info - Notification titles name people's reports, so responses are not logged (D24). */
const quiet = { log: false } as const;
const ID = /^[1-9][0-9]{0,9}$/;

/** @info - Optional `workspaceId` filter (D16): absent means every row of the caller. */
const workspaceFilter = (raw: unknown): number | undefined => {
	if (raw === undefined || raw === null || raw === "") return undefined;
	if (typeof raw !== "string" || !ID.test(raw) || Number(raw) > 2147483647) {
		throw new FieldError({ workspaceId: "Invalid id." });
	}
	return Number(raw);
};

export class NotificationController {
	private static instance: NotificationController;
	private service: NotificationService;

	static getInstance(): NotificationController {
		if (!this.instance) this.instance = new NotificationController();
		return this.instance;
	}

	private constructor() {
		this.service = NotificationService.getInstance();
	}

	listMine = async (c: Context) => {
		const authData = c.get("authData");
		const page = Number(c.req.query("page") ?? "1");
		const limit = Number(c.req.query("limit") ?? "20");
		const data = await this.service.listMine(Number(authData.id), {
			page,
			limit,
			workspaceId: workspaceFilter(c.req.query("workspaceId")),
		});
		return sendSuccessResponse(c, data, 200, quiet);
	};

	unreadCount = async (c: Context) => {
		const authData = c.get("authData");
		const data = await this.service.unreadCount(
			Number(authData.id),
			workspaceFilter(c.req.query("workspaceId")),
		);
		return sendSuccessResponse(c, { count: data });
	};

	markRead = async (c: Context) => {
		const authData = c.get("authData");
		const id = Number(c.req.param("id"));
		const data = await this.service.markRead(Number(authData.id), id);
		return sendSuccessResponse(c, { updated: data });
	};

	/** @info - E21. An empty body is allowed. Only `workspaceId` is accepted. */
	markAllRead = async (c: Context) => {
		const authData = c.get("authData");
		const text = await c.req.text();
		let body: Record<string, unknown> = {};
		if (text.trim() !== "") {
			try {
				const parsed: unknown = JSON.parse(text);
				if (
					typeof parsed !== "object" ||
					parsed === null ||
					Array.isArray(parsed)
				) {
					throw new Error("not an object");
				}
				body = parsed as Record<string, unknown>;
			} catch {
				throw new FieldError({ body: "Send valid JSON or no body." });
			}
		}
		const unknown = Object.keys(body).filter((k) => k !== "workspaceId");
		if (unknown.length > 0) {
			throw new FieldError(
				Object.fromEntries(
					unknown.map((k) => [k, "This field is not accepted."]),
				),
			);
		}
		await this.service.markAllRead(
			Number(authData.id),
			workspaceFilter(body.workspaceId),
		);
		return sendSuccessResponse(c, {
			message: "All notifications marked as read",
		});
	};
}
