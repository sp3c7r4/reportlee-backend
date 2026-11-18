import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers/response";
import { validatedBody } from "@/helpers/validated";
import { callerId } from "@/middlewares/auth/workspace-guards";
import { resolveOrNotFound } from "@/modules/report/scope";
import { ScheduleService } from "./schedule.service";

/** @info - D21: `now` is read once per request here and passed down. */
export class ScheduleController {
	private static instance: ScheduleController;
	private readonly service = ScheduleService.getInstance();
	static getInstance() {
		if (!this.instance) this.instance = new ScheduleController();
		return this.instance;
	}
	private constructor() {}

	get = async (c: Context) => {
		const data = await this.service.get(c.get("caller"), new Date());
		return sendSuccessResponse(c, data, StatusCodes.OK, { log: false });
	};

	put = async (c: Context) => {
		const data = await this.service.put(
			c.get("caller"),
			validatedBody(c),
			new Date(),
		);
		return sendSuccessResponse(c, data, StatusCodes.OK, { log: false });
	};

	private queryCaller = (c: Context) =>
		resolveOrNotFound(callerId(c), Number(c.req.query("workspaceId")));

	current = async (c: Context) => {
		const now = new Date();
		const data = await this.service.current(await this.queryCaller(c), now);
		return sendSuccessResponse(c, data, StatusCodes.OK, { log: false });
	};

	open = async (c: Context) => {
		const now = new Date();
		const data = await this.service.open(await this.queryCaller(c), now);
		return sendSuccessResponse(c, data, StatusCodes.OK, { log: false });
	};
}
