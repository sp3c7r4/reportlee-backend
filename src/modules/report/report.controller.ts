import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers/response";
import { validatedBody } from "@/helpers/validated";
import { callerId } from "@/middlewares/auth/workspace-guards";
import type { ListQuery } from "./report.schema";
import { ReportService } from "./report.service";

/* @info - `{ log: false }` everywhere: report bodies are personal data (AC23). D21: one `now` per request. */
const quiet = { log: false } as const;
const validQuery = <T>(c: Context): T =>
	(c.req as unknown as { valid: (target: "query") => T }).valid("query");

export class ReportController {
	private static instance: ReportController;
	private readonly service = ReportService.getInstance();
	static getInstance() {
		if (!this.instance) this.instance = new ReportController();
		return this.instance;
	}
	private constructor() {}

	private id = (c: Context) => Number(c.req.param("id"));

	list = async (c: Context) => {
		const data = await this.service.list(callerId(c), validQuery<ListQuery>(c));
		return sendSuccessResponse(c, data, StatusCodes.OK, quiet);
	};

	getDraft = async (c: Context) => {
		const data = await this.service.getDraft(
			callerId(c),
			Number(c.req.query("periodId")),
		);
		return sendSuccessResponse(c, data, StatusCodes.OK, quiet);
	};

	saveDraft = async (c: Context) => {
		const data = await this.service.saveDraft(
			callerId(c),
			validatedBody(c),
			new Date(),
		);
		return sendSuccessResponse(c, data, StatusCodes.OK, quiet);
	};

	read = async (c: Context) => {
		const data = await this.service.read(callerId(c), this.id(c));
		return sendSuccessResponse(c, data, StatusCodes.OK, quiet);
	};

	edit = async (c: Context) => {
		const data = await this.service.edit(
			callerId(c),
			this.id(c),
			validatedBody(c),
			new Date(),
		);
		return sendSuccessResponse(c, data, StatusCodes.OK, quiet);
	};

	submit = async (c: Context) => {
		const data = await this.service.submit(callerId(c), this.id(c), new Date());
		return sendSuccessResponse(c, data, StatusCodes.OK, quiet);
	};

	seen = async (c: Context) => {
		const data = await this.service.seen(callerId(c), this.id(c), new Date());
		return sendSuccessResponse(c, data, StatusCodes.OK, quiet);
	};

	remove = async (c: Context) => {
		await this.service.remove(callerId(c), this.id(c), new Date());
		return c.body(null, StatusCodes.NO_CONTENT);
	};
}
