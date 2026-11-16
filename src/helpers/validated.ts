import type { Context } from "hono";

/**
 * @info - The body AFTER Zod ran (trimmed, lower-cased, defaults applied). `c.req.json()` returns
 * the raw body, so a controller that reads it silently skips every transform in the schema.
 */
// biome-ignore lint/suspicious/noExplicitAny: the schema on the route is the type; each caller destructures what it needs.
export const validatedBody = <T = any>(c: Context): T =>
	(c.req as unknown as { valid: (target: "json") => T }).valid("json");
