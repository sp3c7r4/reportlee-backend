/** @info - User-facing strings. No em dash, no SQL, no stack trace. */
export const REPORT_MESSAGES = {
	NOT_FOUND: "Not found.",
	GENERIC: "Something went wrong. Try again.",
	NOT_AUTHOR: "Only the author can do this.",
	NOT_REVIEWER: "Only a reviewer of this report can mark it seen.",
	ADMIN_CANNOT_AUTHOR: "Admins review reports and do not submit them.",
	WORKSPACE_READ_ONLY:
		"This Workspace is read-only. You can read reports but not submit them.",
	NO_SPACE: "You are not in a Space yet. Ask an Admin.",
	PERIOD_CLOSED: "This period is closed. Reports can no longer be submitted.",
	PERIOD_NOT_OPEN: "This period has not started yet.",
	ALREADY_SUBMITTED: "This report is already submitted.",
	NOT_SUBMITTED: "Submit this report before editing it.",
	REPORT_APPROVED: "This report is approved and cannot be edited.",
	EDIT_WINDOW_CLOSED: "The edit window for this report has closed.",
	REPORT_SEEN: "A reviewer has seen this report, so it cannot be deleted.",
	ACCOMPLISHMENTS_MIN: "Write at least 50 characters.",
	SECTION_MAX: "Use 5000 characters or fewer.",
	RAW_TOO_LONG: "This section is too long.",
	UNKNOWN_FIELD: "This field is not accepted.",
	TAGS_INVALID:
		"Tag up to 5 active colleagues from this Workspace, not yourself.",
	NOTHING_TO_UPDATE: "Send at least one field to change.",
} as const;

export const REPORT_CODES = {
	NOT_AUTHOR: "NOT_AUTHOR",
	NOT_REVIEWER: "NOT_REVIEWER",
	ADMIN_CANNOT_AUTHOR: "ADMIN_CANNOT_AUTHOR",
	WORKSPACE_READ_ONLY: "WORKSPACE_READ_ONLY",
	NO_SPACE: "NO_SPACE",
	PERIOD_CLOSED: "PERIOD_CLOSED",
	PERIOD_NOT_OPEN: "PERIOD_NOT_OPEN",
	ALREADY_SUBMITTED: "ALREADY_SUBMITTED",
	NOT_SUBMITTED: "NOT_SUBMITTED",
	REPORT_APPROVED: "REPORT_APPROVED",
	EDIT_WINDOW_CLOSED: "EDIT_WINDOW_CLOSED",
	REPORT_SEEN: "REPORT_SEEN",
} as const;
