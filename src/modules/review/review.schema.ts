import { z } from "zod";
import { idString } from "@/helpers/id-schema";
import { REPORT_MESSAGES } from "@/modules/report/report.message";
import { rejectUnknownKeys } from "@/modules/schedule/schedule.schema";
import { BULK_MAX, REASON_RAW_MAX, REVIEW_MESSAGES } from "./review.message";

export const DECISIONS = ["approve", "reject", "reopen"] as const;
export type Decision = (typeof DECISIONS)[number];

const decisionShape = {
	decision: z.enum(DECISIONS, REVIEW_MESSAGES.DECISION_INVALID),
	reason: z
		.string(REVIEW_MESSAGES.REASON_REQUIRED)
		.max(REASON_RAW_MAX, REVIEW_MESSAGES.REASON_RAW_TOO_LONG)
		.optional(),
};

export const decisionBodySchema = z
	.looseObject(decisionShape)
	.superRefine(
		rejectUnknownKeys(
			Object.keys(decisionShape),
			REPORT_MESSAGES.UNKNOWN_FIELD,
		),
	);
export type DecisionBody = z.infer<z.ZodObject<typeof decisionShape>>;

export const queueQuerySchema = z
	.looseObject({ workspaceId: idString, periodId: idString })
	.superRefine(
		rejectUnknownKeys(
			["workspaceId", "periodId"],
			REPORT_MESSAGES.UNKNOWN_FIELD,
		),
	);
export type QueueQuery = { workspaceId: string; periodId: string };

export const bulkBodySchema = z
	.looseObject({
		workspaceId: idString,
		reportIds: z
			.array(idString, REVIEW_MESSAGES.REPORT_IDS)
			.min(1, REVIEW_MESSAGES.REPORT_IDS)
			.max(BULK_MAX, REVIEW_MESSAGES.REPORT_IDS),
	})
	.superRefine(
		rejectUnknownKeys(
			["workspaceId", "reportIds"],
			REPORT_MESSAGES.UNKNOWN_FIELD,
		),
	);
export type BulkBody = { workspaceId: string; reportIds: string[] };
