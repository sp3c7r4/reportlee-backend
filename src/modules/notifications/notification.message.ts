/**
 * @info - Notification and decision email text (D24). No em dash. The reason text is never in a
 * notification or an email: the reader opens the report to see it.
 */
export const REVIEW_NOTICES = {
	approved: {
		title: "Your report was approved",
		message: "A reviewer approved your report.",
	},
	rejected: {
		title: "Your report needs changes",
		message: "A reviewer sent your report back. Open it to read the reason.",
	},
	reopened: {
		title: "Your report was reopened",
		message: "A reviewer reopened your report. Open it to read the reason.",
	},
	commentToAuthor: {
		title: "New comment on your report",
		message: "A reviewer commented on your report.",
	},
	replyToReviewer: {
		title: "New reply on a report",
		message: "The author replied on a report you review.",
	},
	submission: {
		title: "A report is waiting for review",
		message: "A report was submitted for you to review.",
	},
	task: {
		title: "You have a new task",
		message: "A reviewer assigned you a task from a report.",
	},
} as const;

export const DECISION_EMAIL = {
	approved: {
		subject: "Your report was approved",
		title: "Your report was approved",
		body: "a reviewer approved your report.",
	},
	rejected: {
		subject: "Your report needs changes",
		title: "Your report needs changes",
		body: "a reviewer sent your report back. Open it to read the reason.",
	},
} as const;
