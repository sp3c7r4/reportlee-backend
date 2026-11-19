import { z } from "zod";
import { idString } from "@/helpers/id-schema";
import { REPORT_MESSAGES } from "@/modules/report/report.message";
import { rejectUnknownKeys } from "@/modules/schedule/schedule.schema";
import {
	BODY_RAW_MAX,
	COMMENT_MESSAGES,
	TITLE_RAW_MAX,
} from "./report-comment.message";

/** @info - A real calendar date: `2026-02-30` matches the pattern but is not a day. */
const realDate = (value: string): boolean => {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const d = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

const FOLLOW_UP_KEYS = ["title", "assigneeMembershipId", "dueAt", "priority"];
const followUp = z
	.looseObject({
		title: z
			.string(COMMENT_MESSAGES.TITLE_REQUIRED)
			.max(TITLE_RAW_MAX, COMMENT_MESSAGES.TITLE_RAW_TOO_LONG),
		assigneeMembershipId: idString,
		dueAt: z
			.string(COMMENT_MESSAGES.DUE_AT)
			.refine(realDate, COMMENT_MESSAGES.DUE_AT),
		priority: z.enum(
			["low", "medium", "high", "critical"],
			COMMENT_MESSAGES.PRIORITY,
		),
	})
	.superRefine(
		rejectUnknownKeys(FOLLOW_UP_KEYS, REPORT_MESSAGES.UNKNOWN_FIELD),
	);

const commentShape = {
	body: z
		.string(COMMENT_MESSAGES.BODY_REQUIRED)
		.max(BODY_RAW_MAX, COMMENT_MESSAGES.BODY_RAW_TOO_LONG),
	followUp: followUp.optional(),
};

export const commentBodySchema = z
	.looseObject(commentShape)
	.superRefine(
		rejectUnknownKeys(Object.keys(commentShape), REPORT_MESSAGES.UNKNOWN_FIELD),
	);

export interface CommentBody {
	body: string;
	followUp?: {
		title: string;
		assigneeMembershipId: string;
		dueAt: string;
		priority: "low" | "medium" | "high" | "critical";
	};
}
