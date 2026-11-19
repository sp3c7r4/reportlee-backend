/** @info - User-facing strings of the review module. No em dash, no SQL, no stack trace. */
export const REVIEW_MESSAGES = {
	DECISION_INVALID: "Choose approve, reject or reopen.",
	REASON_REQUIRED: "Write a reason of up to 1000 characters.",
	REASON_TOO_LONG: "Use 1000 characters or fewer.",
	REASON_RAW_TOO_LONG: "Use 1000 characters or fewer.",
	NOT_REVIEWER: "Only Heads and Admins can review.",
	BULK_ADMIN_ONLY: "Only Admins can approve in bulk.",
	REPORT_IDS: "Send between 1 and 100 report ids.",
} as const;

export const REVIEW_CODES = {
	NOT_REVIEWER: "NOT_REVIEWER",
	NOT_FOUND: "NOT_FOUND",
	INTERNAL: "INTERNAL",
} as const;

/** @info - Largest reason, after sanitizing (D13). The raw limit in the schema is wider so tags do not eat it. */
export const REASON_MAX = 1000;
export const REASON_RAW_MAX = 4000;
export const BULK_MAX = 100;
export const QUEUE_CAP = 500;
