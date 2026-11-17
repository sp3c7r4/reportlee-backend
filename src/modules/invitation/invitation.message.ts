export const INVITATION_MESSAGES = {
	INVALID: "This invitation is not valid. Ask for a new one.",
	NOT_FOUND: "Invitation not found.",
	ALREADY_MEMBER_OR_PENDING:
		"That person is already in this Workspace or has a pending invitation.",
	DEACTIVATED_MEMBER:
		"That person already has an account here. Reactivate them from People.",
	SPACE_REQUIRED: "Choose a Space for this role.",
	ADMIN_NO_SPACE: "Admins do not belong to a Space.",
	SPACE_INVALID: "Choose an active Space in this Workspace.",
	HEAD_EXISTS: "This Space already has a Head.",
	HEAD_PENDING: "This Space already has a pending Head invitation.",
	YOU_ALREADY_BELONG: "You already belong to this Workspace.",
	ACCESS_TURNED_OFF:
		"Your access was turned off. Ask an Admin to reactivate you.",
	SPACE_ARCHIVED: "This Space is archived. Ask for a new invitation.",
	DAILY_LIMIT:
		"Daily invite limit reached. You can send more invitations tomorrow.",
	PLATFORM_LIMIT:
		"Invitations are paused for today because of high demand. Please try again tomorrow.",
	mismatch: (masked: string) =>
		`This invitation was sent to ${masked}. Sign in with that address.`,
	subject: (workspaceName: string) =>
		`You are invited to join ${workspaceName} on Reportlee`,
} as const;

export const INVITE_EMAIL_MISMATCH_CODE = "INVITE_EMAIL_MISMATCH";
export const INVITE_DAILY_LIMIT_CODE = "INVITE_DAILY_LIMIT";
export const INVITE_PLATFORM_LIMIT_CODE = "INVITE_PLATFORM_LIMIT";
export const INVITE_EXPIRY_DAYS = 7;
