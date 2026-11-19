import { Hono } from "hono";
import { requireCaller } from "@/middlewares/auth/workspace-guards";
import { reportIdParamSchema } from "@/modules/report/report.schema";
import { JwtService, ZodEngine } from "@/services";
import { ReportCommentController } from "./report-comment.controller";
import { commentBodySchema } from "./report-comment.schema";

/**
 * @info - E14, mounted at /reports. Guards: `jwt.validateToken`, `requireCaller`, Zod (body not
 * logged), then `ReportAccess.assertComment` in the service.
 */
const controller = ReportCommentController.getInstance();
const jwtService = JwtService.getInstance();
const zodEngine = ZodEngine.getInstance();

export const reportCommentRouter = new Hono({ strict: true });
reportCommentRouter.post(
	"/:id/comments",
	jwtService.validateToken,
	requireCaller,
	zodEngine.validate.params(reportIdParamSchema),
	zodEngine.validate.body(commentBodySchema, { log: false }),
	controller.add,
);
