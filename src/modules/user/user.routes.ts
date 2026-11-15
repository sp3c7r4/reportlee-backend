import { Hono } from "hono";
import { FILE_SIZES } from "@/constants/file-size";
import { ImageMimeType } from "@/enums";
import { requireAdmin } from "@/middlewares/auth/guards";
import { FileUploadMiddleware } from "@/middlewares/upload";
import { JwtService, ZodEngine } from "@/services";
import { UserController } from "./user.controller";
import {
	changePasswordSchema,
	changeRoleSchema,
	onboardUserSchema,
	updateUserSchema,
	userIdParamSchema,
} from "./user.schema";

export const userRouter = new Hono({ strict: true });
const userController = UserController.getInstance();
const jwtService = JwtService.getInstance();
const zodEngine = ZodEngine.getInstance();
const upload = FileUploadMiddleware.getInstance();

userRouter.use(jwtService.validateToken);

userRouter.get("/profile", userController.getProfile);
userRouter.get("/sessions", userController.listSessions);
userRouter.delete("/sessions/:refreshId", userController.revokeSession);

userRouter.put(
	"/profile",
	zodEngine.validate.body(updateUserSchema),
	userController.updateProfile,
);

userRouter.put(
	"/avatar",
	upload.single({
		fieldName: "avatar",
		keyFolder: "images/avatars",
		sizeLimit: FILE_SIZES["5MB"],
		allowedTypes: [ImageMimeType.JPEG, ImageMimeType.PNG],
	}),
	userController.updateAvatar,
);

userRouter.put(
	"/password",
	zodEngine.validate.body(changePasswordSchema),
	userController.changePassword,
);

userRouter.post(
	"/onboard",
	zodEngine.validate.formData(onboardUserSchema),
	upload.single({
		fieldName: "avatar",
		keyFolder: "images/avatars",
		sizeLimit: FILE_SIZES["5MB"],
		allowedTypes: [ImageMimeType.JPEG, ImageMimeType.PNG],
		optional: true,
	}),
	userController.onboard,
);

userRouter.delete("/account", userController.deleteAccount);

/* @info - Admin guard runs before validation so a non-admin never learns the body shape. */
userRouter.patch(
	"/:id/role",
	requireAdmin,
	zodEngine.validate.params(userIdParamSchema),
	zodEngine.validate.body(changeRoleSchema),
	userController.changeRole,
);
