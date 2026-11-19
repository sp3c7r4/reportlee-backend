/** @info - User-facing strings of the comment thread. No em dash, no SQL, no stack trace. */
export const COMMENT_MESSAGES = {
	BODY_REQUIRED: "Write a comment of up to 2000 characters.",
	BODY_RAW_TOO_LONG: "Use 2000 characters or fewer.",
	TITLE_REQUIRED: "Write a title of up to 200 characters.",
	TITLE_RAW_TOO_LONG: "Use 200 characters or fewer.",
	DUE_AT: "Use the form YYYY-MM-DD.",
	PRIORITY: "Choose low, medium, high or critical.",
	ASSIGNEE: "Choose an active Staff member or Head of this Workspace.",
	ASSIGNEE_ID: "Choose who the task is for.",
	REVIEWER_MUST_START:
		"A reviewer starts the conversation. You can reply once they write.",
	NOT_REVIEWER: "Only a reviewer of this report can start a comment.",
} as const;

export const COMMENT_CODES = {
	REVIEWER_MUST_START: "REVIEWER_MUST_START",
	NOT_REVIEWER: "NOT_REVIEWER",
} as const;

export const BODY_MAX = 2000;
export const BODY_RAW_MAX = 6000;
export const TITLE_MAX = 200;
export const TITLE_RAW_MAX = 800;
