import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { config } from "@/config";
import { generateMediaKey } from "@/helpers/id-generators";
import {
	sendErrorResponse,
	sendSuccessResponse,
} from "@/helpers/response/send-response";
import { StorageService } from "@/services/storage.service";
import { UPLOAD_MESSAGES } from "./upload.message";

/* @info - Presigning is the default upload path: the browser puts the bytes in the
 * bucket and the API never holds them. A folder is chosen from this allowlist, never
 * from the request, so a caller can only write where the app expects files. */
const PRESIGN_FOLDERS: Record<string, { prefix: string; maxBytes?: number }> = {
	documents: { prefix: "documents" },
	images: { prefix: "images" },
};

const PRESIGN_DEFAULT_PREFIX = "files";

const MIME_BY_EXT: Record<string, string> = {
	pdf: "application/pdf",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	csv: "text/csv",
	txt: "text/plain",
};

/** @info - Browsers send an empty or octet-stream type for real files; infer from
 * the extension so a valid upload is never rejected on a missing header. */
const inferMime = (file: File) => {
	if (
		file.type &&
		file.type !== "application/octet-stream" &&
		file.type !== "text/plain"
	)
		return file.type;
	const ext = (file.name.split(".").pop() ?? "").toLowerCase();
	return MIME_BY_EXT[ext] ?? file.type;
};

export class UploadController {
	private static instance: UploadController;

	private readonly storage: StorageService;

	static getInstance(): UploadController {
		if (!this.instance) this.instance = new UploadController();
		return this.instance;
	}

	private constructor() {
		this.storage = StorageService.getInstance();
	}

	/** A signed PUT the client uploads to; the API stores the key on its own row. */
	presignedUpload = async (c: Context) => {
		const authData = c.get("authData");
		const { contentType, filename, folder } = await c.req.json();

		if (folder && !PRESIGN_FOLDERS[folder]) {
			return sendErrorResponse(
				c,
				{ message: UPLOAD_MESSAGES.FOLDER_NOT_ALLOWED },
				StatusCodes.BAD_REQUEST,
			);
		}

		const ext = filename.split(".").pop() ?? "bin";
		const key = generateMediaKey(
			PRESIGN_FOLDERS[folder]?.prefix ?? PRESIGN_DEFAULT_PREFIX,
			ext,
			authData?.id?.toString(),
		);

		const result = await this.storage.generatePresignedUploadUrl({
			key,
			contentType,
		});

		return sendSuccessResponse(
			c,
			{ ...result, publicUrl: `${config.cdn.url}${key}` },
			StatusCodes.CREATED,
		);
	};

	presignedDownload = async (c: Context) => {
		const key = c.req.param("key") as string;
		const url = await this.storage.generatePresignedDownloadUrl({ key });
		return sendSuccessResponse(c, { url });
	};

	/** Server-side upload for the cases a browser cannot presign (no CORS, tiny files,
	 * a client that should not hold a bucket URL). */
	upload = async (c: Context) => {
		const formData = await c.req.formData();
		const file = formData.get("file") as File | null;

		if (!file || !(file instanceof File)) {
			return sendErrorResponse(
				c,
				{ message: "Missing or invalid file for field 'file'" },
				StatusCodes.BAD_REQUEST,
			);
		}
		if (file.size > 10 * 1024 * 1024) {
			return sendErrorResponse(
				c,
				{ message: "File exceeds size limit of 10 MB" },
				StatusCodes.BAD_REQUEST,
			);
		}

		const fileType = inferMime(file);
		const ext = file.name.split(".").pop() ?? "bin";
		const key = generateMediaKey(
			"files",
			ext,
			c.get("authData")?.id?.toString() ?? "general",
		);

		await this.storage.upload({ key, body: file, contentType: fileType });

		return sendSuccessResponse(
			c,
			{ url: `${config.cdn.url}${key}`, key, name: file.name, size: file.size },
			StatusCodes.CREATED,
		);
	};

	/** A one-shot delete for an object the caller owns. */
	remove = async (c: Context) => {
		const key = c.req.param("key") as string;
		await this.storage.delete(key);
		return sendSuccessResponse(c, { key });
	};
}
