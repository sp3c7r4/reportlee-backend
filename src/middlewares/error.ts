import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ReasonPhrases, StatusCodes } from "http-status-codes";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { CodedConflictError } from "@/errors/CodedConflict";
import { CodedForbiddenError } from "@/errors/CodedForbidden";
import { CodedRateLimitError } from "@/errors/CodedRateLimit";
import { createConflictError } from "@/errors/Conflict";
import { FieldError } from "@/errors/FieldError";
import { sendErrorResponse } from "@/helpers";
import { pgErrorCode } from "@/helpers/pg-error";
import { REPORT_MESSAGES } from "@/modules/report/report.message";

interface ErrorObject {
	status?: ContentfulStatusCode;
	message?: string;
}

export const errorHandler = (err: any, c: Context) => {
	/* @info - D25: a failed query's message holds the SQL and every bound value (report text
	 * included). Answer a generic 500 and log only the pg code, method and path. */
	if (err instanceof DrizzleQueryError) {
		console.error("DB error", {
			pgCode: pgErrorCode(err),
			method: c.req.method,
			path: c.req.path,
		});
		return sendErrorResponse(
			c,
			{ message: REPORT_MESSAGES.GENERIC },
			StatusCodes.INTERNAL_SERVER_ERROR,
		);
	}

	/* @info - A service field rule answers like Zod. Not logged: the fields can hold report text. */
	if (err instanceof FieldError) {
		return sendErrorResponse(c, err.fields, StatusCodes.BAD_REQUEST);
	}

	const errorObject: ErrorObject = {};

	console.log("Error Stack", err);

	if (err instanceof Error) {
		errorObject.status = StatusCodes.INTERNAL_SERVER_ERROR;
		errorObject.message = err.message || ReasonPhrases.INTERNAL_SERVER_ERROR;
	}

	if (err instanceof HTTPException) {
		errorObject.status = err.status;
		errorObject.message = err.message || ReasonPhrases.INTERNAL_SERVER_ERROR;
	}

	if (err && err.name === "ValidationError") {
		errorObject.status = StatusCodes.BAD_REQUEST;
		errorObject.message = err.message.split(": ").pop();
	}

	if (err && (err.code === 11000 || err.cause?.code === 11000)) {
		const mongoError = err.cause || err;
		const message = Object.keys(mongoError.keyValue || {}).join(", ");
		const newConflictError = createConflictError(`${message} already exist`);
		errorObject.status = newConflictError.status;
		errorObject.message = newConflictError.message;
	}

	if (
		err &&
		(err.name === "JsonWebTokenError" || err.name === "TokenExpiredError")
	) {
		errorObject.message = /malformed|algorithm/.test(err.message)
			? "Invalid token"
			: "Session expired";
		errorObject.status = StatusCodes.UNAUTHORIZED;
	}

	if (err && err.name === "CastError") {
		errorObject.message = `${err?.value} is not a valid ${err?.kind}`;
		errorObject.status = StatusCodes.BAD_REQUEST;
	}

	if (err && err.name === "BSONError") {
		errorObject.status = StatusCodes.BAD_REQUEST;
		errorObject.message = err?.message || ReasonPhrases.BAD_REQUEST;
	}

	if (
		err &&
		(err.type === "entity.parse.failed" || err.name === "SyntaxError")
	) {
		errorObject.status = err?.statusCode || err?.status;
		errorObject.message = err?.message?.includes("JSON")
			? "Invalid JSON format in the request body. Please ensure there are no trailing commas."
			: "Syntax Error: Invalid data format.";
	}

	if (err && err.name === "MulterError") {
		errorObject.status = StatusCodes.UNPROCESSABLE_ENTITY;
		errorObject.message = `${err?.message} ${err.field}`;
	}

	return sendErrorResponse(
		c,
		{
			message: errorObject.message || ReasonPhrases.INTERNAL_SERVER_ERROR,
			/* @info - Only a coded 403, 409 or 429 adds a field. Every other error body is just a message. */
			...((err instanceof CodedForbiddenError ||
				err instanceof CodedConflictError ||
				err instanceof CodedRateLimitError) && { code: err.code }),
		},
		errorObject.status || StatusCodes.INTERNAL_SERVER_ERROR,
	);
};
