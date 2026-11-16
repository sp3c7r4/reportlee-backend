import { Hono } from "hono";
import {
	requireCaller,
	requireMembership,
	requireWorkspaceRole,
} from "@/middlewares/auth/workspace-guards";
import { wsIdParamSchema } from "@/modules/workspace/workspace.schema";
import { JwtService, ZodEngine } from "@/services";
import { InvitationController } from "./invitation.controller";
import {
	createInvitationsSchema,
	invitationParamsSchema,
	tokenSchema,
} from "./invitation.schema";

const controller = InvitationController.getInstance();
const jwtService = JwtService.getInstance();
const zodEngine = ZodEngine.getInstance();

/** @info - Mounted at /workspaces/:wsId/invitations in src/routes/router.ts. */
export const workspaceInvitationRouter = new Hono({ strict: true });

const scope = [
	jwtService.validateToken,
	requireCaller,
	zodEngine.validate.params(wsIdParamSchema),
	requireMembership,
] as const;

workspaceInvitationRouter.get(
	"/",
	...scope,
	requireWorkspaceRole("admin", "head"),
	controller.list,
);
/* @info - A Head reaches this route; InvitationService.assertCanInvite enforces Staff only, own Space. */
workspaceInvitationRouter.post(
	"/",
	...scope,
	requireWorkspaceRole("admin", "head"),
	zodEngine.validate.body(createInvitationsSchema, { log: false }),
	controller.create,
);
workspaceInvitationRouter.delete(
	"/:invitationId",
	...scope,
	zodEngine.validate.params(invitationParamsSchema),
	requireWorkspaceRole("admin", "head"),
	controller.revoke,
);

/**
 * @info - Mounted at /invitations. Preview and accept run for a signed-in person who is not (yet)
 * a member, so there is no Workspace guard. The service reads the user row for the verified email (D25).
 */
export const invitationRouter = new Hono({ strict: true });

const auth = [jwtService.validateToken, requireCaller] as const;

invitationRouter.post(
	"/preview",
	...auth,
	zodEngine.validate.body(tokenSchema, { log: false }),
	controller.preview,
);
invitationRouter.post(
	"/accept",
	...auth,
	zodEngine.validate.body(tokenSchema, { log: false }),
	controller.accept,
);
