import { Hono } from "hono";
import { requireCaller } from "@/middlewares/auth/workspace-guards";
import { JwtService, ZodEngine } from "@/services";
import { ReportController } from "./report.controller";
import {
	draftBodySchema,
	draftQuerySchema,
	editBodySchema,
	listQuerySchema,
	reportIdParamSchema,
} from "./report.schema";

/**
 * @info - Mounted at /reports (E5 to E11). No `:wsId`: the Workspace comes from the period or the
 * report row, then resolveOrNotFound, then ReportAccess (D19). Zod runs before any database read,
 * so a bad body from a stranger gets 400 and learns nothing. Specific paths before `/:id`.
 */
export const reportRouter = new Hono({ strict: true });
const controller = ReportController.getInstance();
const jwtService = JwtService.getInstance();
const zodEngine = ZodEngine.getInstance();
const auth = [jwtService.validateToken, requireCaller] as const;
const byId = [...auth, zodEngine.validate.params(reportIdParamSchema)] as const;

reportRouter.get(
	"/",
	...auth,
	zodEngine.validate.query(listQuerySchema),
	controller.list,
);
reportRouter.get(
	"/draft",
	...auth,
	zodEngine.validate.query(draftQuerySchema),
	controller.getDraft,
);
reportRouter.patch(
	"/draft",
	...auth,
	zodEngine.validate.body(draftBodySchema, { log: false }),
	controller.saveDraft,
);
reportRouter.get("/:id", ...byId, controller.read);
reportRouter.patch(
	"/:id",
	...byId,
	zodEngine.validate.body(editBodySchema, { log: false }),
	controller.edit,
);
reportRouter.delete("/:id", ...byId, controller.remove);
reportRouter.post("/:id/submit", ...byId, controller.submit);
