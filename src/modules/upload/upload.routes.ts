import { Hono } from "hono";
import { z } from "zod";
import { JwtService, ZodEngine } from "@/services";
import { UploadController } from "./upload.controller";

export const uploadRouter = new Hono({ strict: true });

const controller = UploadController.getInstance();
const zod = ZodEngine.getInstance();
const jwt = JwtService.getInstance();

const presignedUploadSchema = z.object({
	contentType: z.string().min(1, "contentType is required"),
	filename: z.string().min(1, "filename is required"),
	/* @info - An allowlisted purpose, not a path: the controller holds the list
	 * and answers a message a person can read. */
	folder: z.string().optional(),
});

uploadRouter.use("*", jwt.validateToken);

uploadRouter.post(
	"/presigned",
	zod.validate.body(presignedUploadSchema),
	controller.presignedUpload,
);

uploadRouter.post("/", controller.upload);

uploadRouter.get("/files/:key/download", controller.presignedDownload);
uploadRouter.delete("/files/:key", controller.remove);
