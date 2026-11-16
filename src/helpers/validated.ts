import type { Context } from "hono";

/**
 * @info - The body AFTER Zod ran (trimmed, lower-cased, defaults applied). `c.req.json()` returns
 * the raw body, so a controller that reads it silently skips every transform in the schema.
 */
/* @info - Typed any on purpose: the schema on the route is the type. */
export const validatedBody = <T = any>(c: Context): T =>
	(c.req as unknown as { valid: (target: "json") => T }).valid("json");
