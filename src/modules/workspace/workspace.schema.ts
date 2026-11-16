import { z } from "zod";
import { RESERVED_SLUGS, SLUG_PATTERN } from "@/constants/reserved-slugs";
import { idString } from "@/helpers/id-schema";
import { WORKSPACE_MESSAGES } from "./workspace.message";

const timeZone = z
	.string()
	.min(1)
	.max(64)
	.refine((value) => {
		try {
			new Intl.DateTimeFormat("en", { timeZone: value });
			return true;
		} catch {
			return false;
		}
	}, "Use a valid time zone name, for example Africa/Lagos.");

const name = z
	.string()
	.trim()
	.min(2, "Use 2 to 120 characters.")
	.max(120, "Use 2 to 120 characters.");

export const slugField = z
	.string()
	.min(3, WORKSPACE_MESSAGES.SLUG_FORMAT)
	.max(32, WORKSPACE_MESSAGES.SLUG_FORMAT)
	.regex(SLUG_PATTERN, WORKSPACE_MESSAGES.SLUG_FORMAT)
	.refine((v) => !RESERVED_SLUGS.includes(v), WORKSPACE_MESSAGES.SLUG_RESERVED);

export const wsIdParamSchema = z.object({ wsId: idString });

export const createWorkspaceSchema = z.strictObject({
	name,
	slug: slugField,
	timeZone: timeZone.optional(),
});

export const updateWorkspaceSchema = z
	.strictObject({
		name: name.optional(),
		timeZone: timeZone.optional(),
		locationTagging: z.boolean().optional(),
	})
	.refine(
		(v) => Object.keys(v).length > 0,
		WORKSPACE_MESSAGES.NOTHING_TO_UPDATE,
	);

export const slugQuerySchema = z.object({
	slug: z.string().min(1, "Slug is required.").max(64),
});
