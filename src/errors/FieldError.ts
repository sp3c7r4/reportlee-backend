import { HTTPException } from "hono/http-exception";
import { StatusCodes } from "http-status-codes";
/**
 * @info - A 400 from a service rule (not Zod) with the same body Zod gives: a flat map of field
 * path to message, so the frontend handles both alike.
 */
export class FieldError extends HTTPException {
	readonly fields: Record<string, string>;
	constructor(fields: Record<string, string>) {
		super(StatusCodes.BAD_REQUEST, {
			message: Object.values(fields)[0] ?? "Bad request",
		});
		this.fields = fields;
	}
}
