import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers/response";
import { validatedBody } from "@/helpers/validated";
import { SpaceService } from "./space.service";

export class SpaceController {
	private static instance: SpaceController;
	private readonly service = SpaceService.getInstance();

	static getInstance() {
		if (!this.instance) this.instance = new SpaceController();
		return this.instance;
	}

	private constructor() {}

	list = async (c: Context) => {
		const data = await this.service.list(c.get("caller").workspaceId);
		return sendSuccessResponse(c, data, StatusCodes.OK, { log: false });
	};

	create = async (c: Context) => {
		const { name } = validatedBody(c);
		const data = await this.service.create(c.get("caller"), name);
		return sendSuccessResponse(c, data, StatusCodes.CREATED, { log: false });
	};

	update = async (c: Context) => {
		const body = validatedBody(c);
		const data = await this.service.update(
			c.get("caller"),
			Number(c.req.param("spaceId")),
			body,
		);
		return sendSuccessResponse(c, data, StatusCodes.OK, { log: false });
	};
}
