import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers/response";
import { validatedBody } from "@/helpers/validated";
import { callerId } from "@/middlewares/auth/workspace-guards";
import { InvitationService } from "./invitation.service";

/**
 * @info - `{ log: false }` on every response (D29): the create response carries invite links, and
 * the others carry emails. None of it is written to a log.
 */
export class InvitationController {
	private static instance: InvitationController;
	private readonly service = InvitationService.getInstance();

	static getInstance() {
		if (!this.instance) this.instance = new InvitationController();
		return this.instance;
	}

	private constructor() {}

	list = async (c: Context) => {
		const data = await this.service.list(c.get("caller"));
		return sendSuccessResponse(c, data, StatusCodes.OK, { log: false });
	};

	create = async (c: Context) => {
		const { invitations } = validatedBody(c);
		const data = await this.service.create(c.get("caller"), invitations);
		return sendSuccessResponse(c, data, StatusCodes.CREATED, { log: false });
	};

	revoke = async (c: Context) => {
		const data = await this.service.revoke(
			c.get("caller"),
			Number(c.req.param("invitationId")),
		);
		return sendSuccessResponse(c, data, StatusCodes.OK, { log: false });
	};

	preview = async (c: Context) => {
		const { token } = validatedBody(c);
		const data = await this.service.preview(callerId(c), token);
		return sendSuccessResponse(c, data, StatusCodes.OK, { log: false });
	};

	accept = async (c: Context) => {
		const { token } = validatedBody(c);
		const data = await this.service.accept(callerId(c), token);
		return sendSuccessResponse(c, data, StatusCodes.OK, { log: false });
	};
}
