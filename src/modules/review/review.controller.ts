import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers/response";
import { validatedBody } from "@/helpers/validated";
import { callerId } from "@/middlewares/auth/workspace-guards";
import type { QueueQuery } from "./review.schema";
import { ReviewService } from "./review.service";

/* @info - `{ log: false }` everywhere: reports and reasons are personal data (AC25). One `now` per request. */
const quiet = { log: false } as const;
const validQuery = <T>(c: Context): T =>
	(c.req as unknown as { valid: (target: "query") => T }).valid("query");

export class ReviewController {
	private static instance: ReviewController;
	private readonly service = ReviewService.getInstance();
	static getInstance() {
		if (!this.instance) this.instance = new ReviewController();
		return this.instance;
	}
	private constructor() {}

	decide = async (c: Context) => {
		const data = await this.service.decide(
			callerId(c),
			Number(c.req.param("id")),
			validatedBody(c),
			new Date(),
		);
		return sendSuccessResponse(c, data, StatusCodes.OK, quiet);
	};

	queue = async (c: Context) => {
		const data = await this.service.queue(
			callerId(c),
			validQuery<QueueQuery>(c),
		);
		return sendSuccessResponse(c, data, StatusCodes.OK, quiet);
	};

	bulkApprove = async (c: Context) => {
		const data = await this.service.bulkApprove(
			callerId(c),
			validatedBody(c),
			new Date(),
		);
		return sendSuccessResponse(c, data, StatusCodes.OK, quiet);
	};
}
