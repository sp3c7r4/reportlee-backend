import { Hono } from "hono";
import { requireCaller } from "@/middlewares/auth/workspace-guards";
import { JwtService, ZodEngine } from "@/services";
import { MeController } from "./me.controller";
import { lastWorkspaceSchema } from "./me.schema";

export const meRouter = new Hono({ strict: true });

const meController = MeController.getInstance();
const jwtService = JwtService.getInstance();
const zodEngine = ZodEngine.getInstance();

/* @info - Guard order: validateToken (401), callerId (401), Zod (400), then the service ownership check (404). */
meRouter.use(jwtService.validateToken, requireCaller);

meRouter.get("/memberships", meController.getMemberships);
meRouter.put(
	"/last-workspace",
	zodEngine.validate.body(lastWorkspaceSchema),
	meController.putLastWorkspace,
);
