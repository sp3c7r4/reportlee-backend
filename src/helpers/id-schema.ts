import { z } from "zod";

/**
 * @info - Ids are `integer` in Postgres and strings on the wire. The range check keeps an id past
 * the integer range a 400 here, never a Postgres 22003 (a 500). No leading zero, no sign, no
 * whitespace.
 */
export const idString = z
	.string()
	.regex(/^[1-9][0-9]{0,9}$/, "Invalid id.")
	.refine((value) => Number(value) <= 2147483647, "Invalid id.");
