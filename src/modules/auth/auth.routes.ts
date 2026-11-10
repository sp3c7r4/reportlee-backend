import { Hono } from "hono";
import { serviceHealthCheck } from "@/helpers";
import { metadataGrabber } from "@/middlewares";
import { JwtService, ZodEngine } from "@/services";
import {
	createUserSchema,
	forgotPasswordSchema,
	loginUserSchema,
	refreshTokenSchema,
	resetPasswordSchema,
	selectRoleSchema,
	verifyEmailSchema,
} from "@/shared";
import { AuthController } from "./auth.controller";

export const authRouter = new Hono({ strict: true });
const authController = AuthController.getInstance();

const zodEngine = ZodEngine.getInstance();
const jwtService = JwtService.getInstance();

/** @info- Health Check Route */
authRouter.get("/health", serviceHealthCheck("Auth Service"));

authRouter.post(
	"/signup",
	zodEngine.validate.body(createUserSchema),
	metadataGrabber,
	authController.signup,
);

authRouter.post(
	"/login",
	zodEngine.validate.body(loginUserSchema),
	metadataGrabber,
	authController.login,
);

authRouter.post(
	"/refresh",
	zodEngine.validate.body(refreshTokenSchema),
	authController.refreshToken,
);

authRouter.post(
	"/forgot-password",
	zodEngine.validate.body(forgotPasswordSchema),
	metadataGrabber,
	authController.forgotPassword,
);

authRouter.use(jwtService.validateToken);

authRouter.get("/me", authController.me);

authRouter.post(
	"/verify-email",
	zodEngine.validate.body(verifyEmailSchema),
	authController.verifyEmail,
);

authRouter.post("/resend-otp", authController.resendOtp);

authRouter.post(
	"/reset-password",
	zodEngine.validate.body(resetPasswordSchema),
	authController.resetPassword,
);

authRouter.post(
	"/logout",
	zodEngine.validate.body(refreshTokenSchema),
	authController.logout,
);

authRouter.post(
	"/logout-all",
	zodEngine.validate.body(refreshTokenSchema),
	authController.logoutAll,
);

/** @info - Role selection (post-signup onboarding) */
authRouter.post(
	"/roles",
	zodEngine.validate.body(selectRoleSchema),
	authController.selectRole,
);
