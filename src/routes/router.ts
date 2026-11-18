import { Hono } from "hono";
import { healthCheck } from "@/helpers";
import { authRouter } from "@/modules/auth";
import {
	invitationRouter,
	workspaceInvitationRouter,
} from "@/modules/invitation";
import { meRouter } from "@/modules/me";
import { memberRouter } from "@/modules/membership";
import { notificationRouter } from "@/modules/notifications";
import { reportRouter } from "@/modules/report";
import { periodRouter, scheduleRouter } from "@/modules/schedule";
import { spaceRouter } from "@/modules/space";
import { uploadRouter } from "@/modules/upload";
import { userRouter } from "@/modules/user/user.routes";
import { workspaceRouter } from "@/modules/workspace";

/**
 * @info - Every versioned route hangs off this one router, mounted at /api/v1.
 * A new module adds one line here and nothing else in the app changes.
 */
export const router = new Hono();

router.get("/", healthCheck);

router.route("/auth", authRouter);
router.route("/user", userRouter);
router.route("/notifications", notificationRouter);
router.route("/upload", uploadRouter);
router.route("/me", meRouter);
router.route("/workspaces", workspaceRouter);
router.route("/workspaces/:wsId/spaces", spaceRouter);
router.route("/workspaces/:wsId/members", memberRouter);
router.route("/workspaces/:wsId/invitations", workspaceInvitationRouter);
router.route("/invitations", invitationRouter);
router.route("/workspaces/:wsId/schedule", scheduleRouter);
router.route("/reporting-periods", periodRouter);
router.route("/reports", reportRouter);
