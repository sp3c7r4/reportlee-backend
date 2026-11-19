import { Hono } from "hono";
import { requireCaller } from "@/middlewares/auth/workspace-guards";
import { reportIdParamSchema } from "@/modules/report/report.schema";
import { JwtService, ZodEngine } from "@/services";
import { ReviewController } from "./review.controller";
import {
	bulkBodySchema,
	decisionBodySchema,
	queueQuerySchema,
} from "./review.schema";

/**
 * @info - Guards on every route: `jwt.validateToken`, `requireCaller`, Zod, then membership and
 * role inside the service (`ReportAccess.assertDecide` for a decision). `/review` holds the queue
 * and bulk approve. `reportDecisionRouter` is mounted at `/reports` beside the report router: its
 * path has a second segment, so it cannot clash with `/:id`.
 */
const controller = ReviewController.getInstance();
const jwtService = JwtService.getInstance();
const zodEngine = ZodEngine.getInstance();
const auth = [jwtService.validateToken, requireCaller] as const;

export const reviewRouter = new Hono({ strict: true });
reviewRouter.get(
	"/queue",
	...auth,
	zodEngine.validate.query(queueQuerySchema),
	controller.queue,
);
reviewRouter.post(
	"/bulk-approve",
	...auth,
	zodEngine.validate.body(bulkBodySchema, { log: false }),
	controller.bulkApprove,
);

export const reportDecisionRouter = new Hono({ strict: true });
reportDecisionRouter.post(
	"/:id/decision",
	...auth,
	zodEngine.validate.params(reportIdParamSchema),
	zodEngine.validate.body(decisionBodySchema, { log: false }),
	controller.decide,
);
