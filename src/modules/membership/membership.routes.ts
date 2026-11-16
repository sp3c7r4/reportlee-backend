import { Hono } from "hono";
import {
	requireCaller,
	requireMembership,
	requireWorkspaceRole,
} from "@/middlewares/auth/workspace-guards";
import { wsIdParamSchema } from "@/modules/workspace/workspace.schema";
import { JwtService, ZodEngine } from "@/services";
import { MembershipController } from "./membership.controller";
import { memberParamsSchema, updateMemberSchema } from "./membership.schema";

/** @info - Mounted at /workspaces/:wsId/members in src/routes/router.ts. */
export const memberRouter = new Hono({ strict: true });

const controller = MembershipController.getInstance();
const jwtService = JwtService.getInstance();
const zodEngine = ZodEngine.getInstance();

const scope = [
	jwtService.validateToken,
	requireCaller,
	zodEngine.validate.params(wsIdParamSchema),
	requireMembership,
];

memberRouter.get("/", ...scope, controller.list);
memberRouter.patch(
	"/:membershipId",
	...scope,
	zodEngine.validate.params(memberParamsSchema),
	requireWorkspaceRole("admin"),
	zodEngine.validate.body(updateMemberSchema),
	controller.update,
);
