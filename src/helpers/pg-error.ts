/** @info - Postgres error code from a driver error. Drizzle wraps it in `cause`. */
export const pgErrorCode = (error: unknown): string | undefined => {
	const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
	const code = e?.cause?.code ?? e?.code;
	return typeof code === "string" ? code : undefined;
};

export const isUniqueViolation = (error: unknown) =>
	pgErrorCode(error) === "23505";
