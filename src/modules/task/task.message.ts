/** @info - User-facing strings of the task module. No em dash, no SQL, no stack trace. */
export const TASK_MESSAGES = {
	NOT_ASSIGNEE: "Only the person it is assigned to can change this task.",
	VIEW_NOT_ALLOWED: "You cannot use this view.",
	NOTE_WITH_DONE: "A note goes with a finished task.",
	FILE_WITH_DONE: "A file goes with a finished task.",
	NOTE_TOO_LONG: "Use 1000 characters or fewer.",
	STATUS_INVALID: "Choose todo, doing or done.",
	VIEW_INVALID: "Choose mine, by, space or all.",
} as const;

export const TASK_CODES = {
	NOT_ASSIGNEE: "NOT_ASSIGNEE",
	VIEW_NOT_ALLOWED: "VIEW_NOT_ALLOWED",
} as const;

export const NOTE_MAX = 1000;
export const LIST_CAP = 500;
/** @info - V6: the Done list shows the last 14 days, decided by the server. */
export const DONE_WINDOW_DAYS = 14;
