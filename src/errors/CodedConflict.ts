import { HTTPException } from "hono/http-exception";
import { StatusCodes } from "http-status-codes";
/** @info - A 409 that carries a stable machine code beside the message, like CodedForbiddenError. */
export class CodedConflictError extends HTTPException {
	readonly code: string;
	constructor(message: string, code: string) {
		super(StatusCodes.CONFLICT, { message });
		this.code = code;
	}
}
