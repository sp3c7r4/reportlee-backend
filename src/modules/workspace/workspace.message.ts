export const WORKSPACE_MESSAGES = {
	NOT_FOUND: "Workspace not found.",
	FORBIDDEN: "You do not have permission to do this.",
	AUTH_REQUIRED: "Authentication required.",
	EMAIL_NOT_VERIFIED:
		"Email not verified. Please verify your email to continue.",
	SLUG_TAKEN: "That address is already taken.",
	SLUG_FORMAT: "Use 3 to 32 lowercase letters, digits or hyphens.",
	SLUG_RESERVED: "That address is reserved. Choose another.",
	NOTHING_TO_UPDATE: "Send at least one field to change.",
} as const;

export const EMAIL_NOT_VERIFIED_CODE = "EMAIL_NOT_VERIFIED";
