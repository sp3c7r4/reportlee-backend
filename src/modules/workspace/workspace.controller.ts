import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers/response";
import { callerId } from "@/middlewares/auth/workspace-guards";
import { WorkspaceService } from "./workspace.service";

/** @info - `{ log: false }` on every response here (D29): names and slugs are not written to logs. */
export class WorkspaceController {
	private static instance: WorkspaceController;
	private readonly service = WorkspaceService.getInstance();

	static getInstance() {
		if (!this.instance) this.instance = new WorkspaceController();
		return this.instance;
	}

	private constructor() {}

	slugAvailable = async (c: Context) => {
		const slug = c.req.query("slug") ?? "";
		const data = await this.service.slugAvailable(slug);
		return sendSuccessResponse(c, data, StatusCodes.OK, { log: false });
	};

	create = async (c: Context) => {
		const body = await c.req.json();
		const data = await this.service.create(callerId(c), body);
		return sendSuccessResponse(c, data, StatusCodes.CREATED, { log: false });
	};

	get = async (c: Context) => {
		const data = await this.service.get(c.get("caller").workspaceId);
		return sendSuccessResponse(c, data, StatusCodes.OK, { log: false });
	};

	update = async (c: Context) => {
		const body = await c.req.json();
		const data = await this.service.update(c.get("caller"), body);
		return sendSuccessResponse(c, data, StatusCodes.OK, { log: false });
	};
}
