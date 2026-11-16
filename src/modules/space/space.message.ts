export const SPACE_MESSAGES = {
	NOT_FOUND: "Space not found.",
	NAME_TAKEN: (name: string) => `${name} is already a Space.`,
	ARCHIVE_HAS_MEMBERS: "Move its members out before archiving this Space.",
	LIMIT_REACHED: "A Workspace can have at most 50 Spaces.",
	HEAD_INVALID: "Choose an active member of this Space.",
	HEAD_ELSEWHERE: "That person already heads another Space.",
	TEMPLATE_ONLY: "A Head can only change the KPI template of their own Space.",
} as const;

export const MAX_SPACES = 50;
