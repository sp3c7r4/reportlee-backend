import { z } from "zod";
import { idString } from "@/helpers/id-schema";

export const memberParamsSchema = z.object({
	wsId: idString,
	membershipId: idString,
});

export const updateMemberSchema = z
	.strictObject({
		role: z.enum(["staff", "head", "admin"]).optional(),
		spaceId: idString.nullable().optional(),
		active: z.boolean().optional(),
	})
	.refine(
		(v) => Object.keys(v).length > 0,
		"Send at least one field to change.",
	);
