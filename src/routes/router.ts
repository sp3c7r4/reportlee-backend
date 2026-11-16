import { Hono } from "hono";
import { healthCheck } from "@/helpers";
import { authRouter } from "@/modules/auth";
import { meRouter } from "@/modules/me";
import { memberRouter } from "@/modules/membership";
import { notificationRouter } from "@/modules/notifications";
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
