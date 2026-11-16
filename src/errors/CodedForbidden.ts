import { HTTPException } from "hono/http-exception";
import { StatusCodes } from "http-status-codes";

/** @info - A 403 that carries a stable machine code beside the message. The frontend branches on the code, never on the text. */
export class CodedForbiddenError extends HTTPException {
	readonly code: string;

	constructor(message: string, code: string) {
		super(StatusCodes.FORBIDDEN, { message });
		this.code = code;
	}
}
