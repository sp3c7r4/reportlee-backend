import { z } from "zod";

/**
 * @info - Onboarding arrives as multipart form data (the avatar rides along), so
 * every structured field is a JSON string on the wire and an object here. The
 * preprocess helper is the one place that conversion happens.
 */
const fromFormData = <T extends z.ZodTypeAny>(schema: T) =>
	z.preprocess((value) => {
		if (typeof value !== "string") return value;
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}, schema);

export const onboardUserSchema = z.object({
	bio: z.string().optional(),
	/* @info - Clamped to the users.title column width rather than rejected: /user/onboard
	 * reads raw form data, and an over-long headline must not fail the whole signup. */
	title: z.string().max(120).optional(),
	notifications: fromFormData(
		z
			.object({
				email: z.boolean().optional(),
				sms: z.boolean().optional(),
				whatsapp: z.boolean().optional(),
				push: z.boolean().optional(),
			})
			.optional(),
	),
});

export const updateUserSchema = z.object({
	firstName: z.string().min(1).optional(),
	lastName: z.string().max(255).optional(),
	phone: z.string().optional(),
	bio: z.string().optional(),
	/* @info - A short headline; capped to the users.title column width. */
	title: z.string().max(120).optional(),
	preferences: z
		.object({
			notifications: z
				.object({
					email: z.boolean().optional(),
					sms: z.boolean().optional(),
					whatsapp: z.boolean().optional(),
					push: z.boolean().optional(),
				})
				.optional(),
		})
		.optional(),
});

export const changePasswordSchema = z.object({
	currentPassword: z.string().min(1, "Current password is required"),
	newPassword: z.string().min(8, "Password must be at least 8 characters"),
});
