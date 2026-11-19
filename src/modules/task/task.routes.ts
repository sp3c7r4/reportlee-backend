import { Hono } from "hono";
import { requireCaller } from "@/middlewares/auth/workspace-guards";
import { JwtService, ZodEngine } from "@/services";
import { TaskController } from "./task.controller";
import {
	listQuerySchema,
	moveBodySchema,
	taskIdParamSchema,
} from "./task.schema";

/**
 * @info - Mounted at /tasks (E17, E18). Guards: `jwt.validateToken`, `requireCaller`, Zod, then
 * membership, the view rule and the assignee rule in TaskService.
 */
const controller = TaskController.getInstance();
const jwtService = JwtService.getInstance();
const zodEngine = ZodEngine.getInstance();
const auth = [jwtService.validateToken, requireCaller] as const;

export const taskRouter = new Hono({ strict: true });
taskRouter.get(
	"/",
	...auth,
	zodEngine.validate.query(listQuerySchema),
	controller.list,
);
taskRouter.patch(
	"/:id",
	...auth,
	zodEngine.validate.params(taskIdParamSchema),
	zodEngine.validate.body(moveBodySchema, { log: false }),
	controller.move,
);
