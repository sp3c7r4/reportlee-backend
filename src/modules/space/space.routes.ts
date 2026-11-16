import { Hono } from "hono";
import {
	requireCaller,
	requireMembership,
	requireWorkspaceRole,
} from "@/middlewares/auth/workspace-guards";
import { wsIdParamSchema } from "@/modules/workspace/workspace.schema";
import { JwtService, ZodEngine } from "@/services";
import { SpaceController } from "./space.controller";
import {
	createSpaceSchema,
	spaceParamsSchema,
	updateSpaceSchema,
} from "./space.schema";

/** @info - Mounted at /workspaces/:wsId/spaces in src/routes/router.ts. */
export const spaceRouter = new Hono({ strict: true });

const controller = SpaceController.getInstance();
const jwtService = JwtService.getInstance();
const zodEngine = ZodEngine.getInstance();

const scope = [
	jwtService.validateToken,
	requireCaller,
	zodEngine.validate.params(wsIdParamSchema),
	requireMembership,
];

spaceRouter.get("/", ...scope, controller.list);
spaceRouter.post(
	"/",
	...scope,
	requireWorkspaceRole("admin"),
	zodEngine.validate.body(createSpaceSchema),
	controller.create,
);
/* @info - A Head reaches this route; SpaceService allows only kpiTemplate on their own Space. */
spaceRouter.patch(
	"/:spaceId",
	...scope,
	zodEngine.validate.params(spaceParamsSchema),
	requireWorkspaceRole("admin", "head"),
	zodEngine.validate.body(updateSpaceSchema),
	controller.update,
);
