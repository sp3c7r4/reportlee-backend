import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers/response";
import { validatedBody } from "@/helpers/validated";
import { MembershipService } from "./membership.service";

/** @info - `{ log: false }`: the roster holds names and emails, which never reach a log (D29, AC11). */
export class MembershipController {
	private static instance: MembershipController;
	private readonly service = MembershipService.getInstance();

	static getInstance() {
		if (!this.instance) this.instance = new MembershipController();
		return this.instance;
	}

	private constructor() {}

	list = async (c: Context) => {
		const data = await this.service.roster(c.get("caller"));
		return sendSuccessResponse(c, data, StatusCodes.OK, { log: false });
	};

	update = async (c: Context) => {
		const data = await this.service.updateMember(
			c.get("caller"),
			Number(c.req.param("membershipId")),
			validatedBody(c),
		);
		return sendSuccessResponse(c, data, StatusCodes.OK, { log: false });
	};
}
