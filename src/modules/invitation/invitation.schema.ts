import { z } from "zod";
import { idString } from "@/helpers/id-schema";

const email = z
	.string()
	.trim()
	.toLowerCase()
	.max(255, "Use 255 characters or fewer.")
	.pipe(z.email("Enter a valid email address."));

export const invitationParamsSchema = z.object({
	wsId: idString,
	invitationId: idString,
});

export const createInvitationsSchema = z.strictObject({
	invitations: z
		.array(
			z.strictObject({
				email,
				role: z.enum(["staff", "head", "admin"]),
				spaceId: idString.nullable().optional(),
			}),
		)
		.min(1, "Add at least one invitation.")
		.max(5, "Send at most 5 invitations at a time.")
		.refine(
			(rows) => new Set(rows.map((r) => r.email)).size === rows.length,
			"Each email can appear once.",
		),
});

export const tokenSchema = z.strictObject({
	token: z
		.string()
		.min(20, "Invalid invitation.")
		.max(100, "Invalid invitation."),
});
