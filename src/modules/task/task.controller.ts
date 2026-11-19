import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers/response";
import { validatedBody } from "@/helpers/validated";
import { callerId } from "@/middlewares/auth/workspace-guards";
import type { TaskListQuery } from "./task.schema";
import { TaskService } from "./task.service";

/* @info - `{ log: false }`: titles and notes are untrusted personal text (AC25). */
const quiet = { log: false } as const;
const validQuery = <T>(c: Context): T =>
	(c.req as unknown as { valid: (target: "query") => T }).valid("query");

export class TaskController {
	private static instance: TaskController;
	private readonly service = TaskService.getInstance();
	static getInstance() {
		if (!this.instance) this.instance = new TaskController();
		return this.instance;
	}
	private constructor() {}

	list = async (c: Context) => {
		const data = await this.service.list(
			callerId(c),
			validQuery<TaskListQuery>(c),
			new Date(),
		);
		return sendSuccessResponse(c, data, StatusCodes.OK, quiet);
	};

	move = async (c: Context) => {
		const data = await this.service.move(
			callerId(c),
			Number(c.req.param("id")),
			validatedBody(c),
			new Date(),
		);
		return sendSuccessResponse(c, data, StatusCodes.OK, quiet);
	};
}
