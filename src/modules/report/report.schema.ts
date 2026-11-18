import { z } from "zod";
import { idString } from "@/helpers/id-schema";
import { rejectUnknownKeys } from "@/modules/schedule/schedule.schema";
import { REPORT_MESSAGES } from "./report.message";
import { MAX_RAW_HTML } from "./report-sanitizer";

const section = z
	.string("Enter text.")
	.max(MAX_RAW_HTML, REPORT_MESSAGES.RAW_TOO_LONG)
	.optional();

/* @info - Loose items: the frontend sends `unit` on a KPI row and `uploaded` on an attachment, and
 * the server ignores both (D13, D14). */
const kpiRow = z.looseObject({
	name: z.string("Enter a name.").min(1, "Enter a name.").max(80),
	value: z
		.number("Enter a number.")
		.refine((n) => Number.isFinite(n) && Math.abs(n) <= 1e12, "Enter a number.")
		.nullable(),
});
const attachment = z.looseObject({
	name: z.string().min(1).max(255),
	size: z.number().int().min(0).max(10485760),
	type: z.string().max(100),
});
const finite = z.number().refine(Number.isFinite, "Enter a number.");
const location = z
	.object({
		latitude: finite.refine((n) => n >= -90 && n <= 90, "Use -90 to 90."),
		longitude: finite.refine((n) => n >= -180 && n <= 180, "Use -180 to 180."),
		accuracy: finite.refine((n) => n >= 0, "Use 0 or more."),
	})
	.nullable()
	.optional();

const contentShape = {
	accomplishments: section,
	challenges: section,
	plans: section,
	kpis: z.array(kpiRow).max(30, "Use 30 KPI rows or fewer.").optional(),
	attachments: z
		.array(attachment)
		.max(10, "Use 10 attachments or fewer.")
		.optional(),
	taggedMembershipIds: z
		.array(idString)
		.max(5, REPORT_MESSAGES.TAGS_INVALID)
		.refine(
			(ids) => new Set(ids).size === ids.length,
			REPORT_MESSAGES.TAGS_INVALID,
		)
		.optional(),
	location,
};
const CONTENT_KEYS = Object.keys(contentShape);

export const draftBodySchema = z
	.looseObject({ periodId: idString, ...contentShape })
	.superRefine(
		rejectUnknownKeys(
			["periodId", ...CONTENT_KEYS],
			REPORT_MESSAGES.UNKNOWN_FIELD,
		),
	);
/* @info - Typed from a plain object: a loose object's index signature would hide the known keys. */
const contentObject = z.object(contentShape);
export type ContentBody = z.infer<typeof contentObject>;
export type DraftBody = ContentBody & { periodId: string };

/* @info - An empty edit is keyed `message`, so the frontend shows it as a plain message. */
export const editBodySchema = z
	.looseObject(contentShape)
	.superRefine((value, ctx) => {
		rejectUnknownKeys(CONTENT_KEYS, REPORT_MESSAGES.UNKNOWN_FIELD)(value, ctx);
		if (Object.keys(value).length === 0) {
			ctx.addIssue({
				code: "custom",
				path: ["message"],
				message: REPORT_MESSAGES.NOTHING_TO_UPDATE,
			});
		}
	});
export type EditBody = ContentBody;

export const reportIdParamSchema = z.object({ id: idString });
export const draftQuerySchema = z.object({ periodId: idString });
export const listQuerySchema = z.object({
	workspaceId: idString,
	periodId: idString.optional(),
	status: z.enum(["draft"], "Use status=draft or leave it out.").optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
});
export type ListQuery = z.infer<typeof listQuerySchema>;
