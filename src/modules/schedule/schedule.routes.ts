import { Hono } from "hono";
import {
	requireCaller,
	requireMembership,
	requireWorkspaceRole,
} from "@/middlewares/auth/workspace-guards";
import { wsIdParamSchema } from "@/modules/workspace/workspace.schema";
import { JwtService, ZodEngine } from "@/services";
import { ScheduleController } from "./schedule.controller";
import { scheduleBodySchema, workspaceQuerySchema } from "./schedule.schema";

const controller = ScheduleController.getInstance();
const jwtService = JwtService.getInstance();
const zodEngine = ZodEngine.getInstance();

/** @info - Mounted at /workspaces/:wsId/schedule in src/routes/router.ts (E1, E2). */
export const scheduleRouter = new Hono({ strict: true });
const scope = [
	jwtService.validateToken,
	requireCaller,
	zodEngine.validate.params(wsIdParamSchema),
	requireMembership,
] as const;
scheduleRouter.get("/", ...scope, controller.get);
/* @info - Role before body: a non-Admin gets 403 whatever the body holds. */
scheduleRouter.put(
	"/",
	...scope,
	requireWorkspaceRole("admin"),
	zodEngine.validate.body(scheduleBodySchema),
	controller.put,
);

/** @info - Mounted at /reporting-periods (E3, E4). The Workspace comes from the query, then resolveOrNotFound. */
export const periodRouter = new Hono({ strict: true });
const periodScope = [
	jwtService.validateToken,
	requireCaller,
	zodEngine.validate.query(workspaceQuerySchema),
] as const;
periodRouter.get("/current", ...periodScope, controller.current);
periodRouter.get("/open", ...periodScope, controller.open);
