/**
 * @info - Slugs the product cannot hand out. A copy of RESERVED_SLUGS in the frontend's
 * src/lib/onboarding.ts: tests/workspace.test.ts reads that file and fails when the two differ.
 */
export const RESERVED_SLUGS: readonly string[] = [
	"www",
	"app",
	"api",
	"admin",
	"mail",
	"smtp",
	"ns",
	"cdn",
	"docs",
	"help",
	"support",
	"status",
	"billing",
	"account",
	"dashboard",
	"login",
	"signup",
];

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
