import { Hono } from "hono";
import {
	requireCaller,
	requireMembership,
	requireWorkspaceRole,
} from "@/middlewares/auth/workspace-guards";
import { JwtService, ZodEngine } from "@/services";
import { WorkspaceController } from "./workspace.controller";
import {
	createWorkspaceSchema,
	slugQuerySchema,
	updateWorkspaceSchema,
	wsIdParamSchema,
} from "./workspace.schema";

export const workspaceRouter = new Hono({ strict: true });

const controller = WorkspaceController.getInstance();
const jwtService = JwtService.getInstance();
const zodEngine = ZodEngine.getInstance();

/* @info - Guard order: validateToken, callerId, Zod params, requireMembership (404), role (403), then the service.
 * Applied per route, not with use(), so routers mounted under /workspaces/:wsId do not run it twice. */
const auth = [jwtService.validateToken, requireCaller];

/* @info - Specific paths before /:wsId. */
workspaceRouter.get(
	"/slug-available",
	...auth,
	zodEngine.validate.query(slugQuerySchema),
	controller.slugAvailable,
);
workspaceRouter.post(
	"/",
	...auth,
	zodEngine.validate.body(createWorkspaceSchema),
	controller.create,
);
workspaceRouter.get(
	"/:wsId",
	...auth,
	zodEngine.validate.params(wsIdParamSchema),
	requireMembership,
	controller.get,
);
workspaceRouter.patch(
	"/:wsId",
	...auth,
	zodEngine.validate.params(wsIdParamSchema),
	requireMembership,
	requireWorkspaceRole("admin"),
	zodEngine.validate.body(updateWorkspaceSchema),
	controller.update,
);
