import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers/response";
import { validatedBody } from "@/helpers/validated";
import { callerId } from "@/middlewares/auth/workspace-guards";
import { MeService } from "./me.service";

/** @info - `{ log: false }`: these bodies hold names and emails, which never reach a log (D29). */
export class MeController {
	private static instance: MeController;
	private readonly meService = MeService.getInstance();

	static getInstance() {
		if (!this.instance) this.instance = new MeController();
		return this.instance;
	}

	private constructor() {}

	getMemberships = async (c: Context) => {
		const data = await this.meService.memberships(callerId(c));
		return sendSuccessResponse(c, data, StatusCodes.OK, { log: false });
	};

	putLastWorkspace = async (c: Context) => {
		const { workspaceId } = validatedBody(c);
		const data = await this.meService.setLastWorkspace(
			callerId(c),
			Number(workspaceId),
		);
		return sendSuccessResponse(c, data, StatusCodes.OK, { log: false });
	};
}
