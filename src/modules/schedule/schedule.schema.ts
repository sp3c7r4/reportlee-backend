import { z } from "zod";
import { idString } from "@/helpers/id-schema";
import { timeZone } from "@/modules/workspace/workspace.schema";
import { WEEKDAYS } from "./period-calendar";
import { TIME_RE } from "./schedule.constants";
import { SCHEDULE_MESSAGES } from "./schedule.message";

/**
 * @info - zod 4 reports a strictObject's unknown keys with an empty path, which ZodEngine would key
 * as "". A loose object plus this refinement keys each unknown field by its own name instead.
 */
export const rejectUnknownKeys =
	(allowed: readonly string[], message: string) =>
	(value: Record<string, unknown>, ctx: z.RefinementCtx) => {
		for (const key of Object.keys(value)) {
			if (!allowed.includes(key)) {
				ctx.addIssue({ code: "custom", path: [key], message });
			}
		}
	};

const SCHEDULE_KEYS = [
	"cadence",
	"weekday",
	"time",
	"timeZone",
	"dayOfMonth",
	"lastDay",
] as const;

export const scheduleBodySchema = z
	.looseObject({
		cadence: z.enum(
			["daily", "weekly", "fortnightly", "monthly", "quarterly"],
			SCHEDULE_MESSAGES.CADENCE,
		),
		weekday: z.string(SCHEDULE_MESSAGES.WEEKDAY).optional(),
		time: z
			.string(SCHEDULE_MESSAGES.TIME)
			.regex(TIME_RE, SCHEDULE_MESSAGES.TIME),
		timeZone,
		dayOfMonth: z
			.number(SCHEDULE_MESSAGES.DAY_OF_MONTH)
			.int(SCHEDULE_MESSAGES.DAY_OF_MONTH)
			.min(1, SCHEDULE_MESSAGES.DAY_OF_MONTH)
			.max(31, SCHEDULE_MESSAGES.DAY_OF_MONTH)
			.nullable()
			.optional(),
		lastDay: z.boolean(SCHEDULE_MESSAGES.LAST_DAY).optional(),
	})
	.superRefine((value, ctx) => {
		rejectUnknownKeys(SCHEDULE_KEYS, SCHEDULE_MESSAGES.UNKNOWN_FIELD)(
			value,
			ctx,
		);
		const weekly =
			value.cadence === "weekly" || value.cadence === "fortnightly";
		if (
			weekly &&
			!WEEKDAYS.includes(value.weekday as (typeof WEEKDAYS)[number])
		) {
			ctx.addIssue({
				code: "custom",
				path: ["weekday"],
				message: SCHEDULE_MESSAGES.WEEKDAY,
			});
		}
		const monthly =
			value.cadence === "monthly" || value.cadence === "quarterly";
		if (
			monthly &&
			!value.lastDay &&
			(value.dayOfMonth === undefined || value.dayOfMonth === null)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["dayOfMonth"],
				message: SCHEDULE_MESSAGES.DAY_OF_MONTH,
			});
		}
	});
export type ScheduleBody = z.infer<typeof scheduleBodySchema>;

export const workspaceQuerySchema = z.object({ workspaceId: idString });
