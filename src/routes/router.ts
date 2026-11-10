import { Hono } from "hono";
import { healthCheck } from "@/helpers";
import { authRouter } from "@/modules/auth";
import { notificationRouter } from "@/modules/notifications";
import { uploadRouter } from "@/modules/upload";
import { userRouter } from "@/modules/user/user.routes";

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
