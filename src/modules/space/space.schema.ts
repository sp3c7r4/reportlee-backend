import { z } from "zod";
import { idString } from "@/helpers/id-schema";

const spaceName = z
	.string()
	.trim()
	.min(1, "Enter a name.")
	.max(80, "Use 80 characters or fewer.");

export const spaceParamsSchema = z.object({
	wsId: idString,
	spaceId: idString,
});

export const createSpaceSchema = z.strictObject({ name: spaceName });

export const updateSpaceSchema = z
	.strictObject({
		name: spaceName.optional(),
		headMembershipId: idString.nullable().optional(),
		archived: z.boolean().optional(),
		kpiTemplate: z
			.array(
				z.strictObject({
					name: z.string().trim().min(1, "Enter a name.").max(60),
					unit: z.string().trim().max(20),
				}),
			)
			.max(20, "Use 20 rows or fewer.")
			.optional(),
	})
	.refine(
		(v) => Object.keys(v).length > 0,
		"Send at least one field to change.",
	);
