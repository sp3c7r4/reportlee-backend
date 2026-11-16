export const MEMBERSHIP_MESSAGES = {
	NOT_FOUND: "Member not found.",
	LAST_ADMIN: "A Workspace needs at least one active Admin.",
	ADMIN_NO_SPACE: "Admins do not belong to a Space.",
	SPACE_REQUIRED: "Choose a Space for this role.",
	SPACE_INVALID: "Choose an active Space in this Workspace.",
	HEAD_EXISTS:
		"This Space already has a Head. Replace the Head from the Space page.",
	HEAD_CANNOT_MOVE:
		"A Head cannot change Space. Replace the Head from the Space page first.",
	HEAD_NEEDS_ACTIVE: "Reactivate this person before making them a Head.",
} as const;
