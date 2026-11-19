import { z } from "zod";
import { idString } from "@/helpers/id-schema";
import { REPORT_MESSAGES } from "@/modules/report/report.message";
import { rejectUnknownKeys } from "@/modules/schedule/schedule.schema";
import { NOTE_MAX, TASK_MESSAGES } from "./task.message";

export const VIEWS = ["mine", "by", "space", "all"] as const;
export type TaskView = (typeof VIEWS)[number];

export const listQuerySchema = z
	.looseObject({
		workspaceId: idString,
		view: z.enum(VIEWS, TASK_MESSAGES.VIEW_INVALID),
	})
	.superRefine(
		rejectUnknownKeys(["workspaceId", "view"], REPORT_MESSAGES.UNKNOWN_FIELD),
	);
export type TaskListQuery = { workspaceId: string; view: TaskView };

export const taskIdParamSchema = z.object({ id: idString });

const moveShape = {
	status: z.enum(["todo", "doing", "done"], TASK_MESSAGES.STATUS_INVALID),
	completionNote: z
		.string(TASK_MESSAGES.NOTE_TOO_LONG)
		.max(NOTE_MAX, TASK_MESSAGES.NOTE_TOO_LONG)
		.optional(),
	completionFile: z
		.object({
			name: z.string().min(1).max(255),
			size: z.number().int().min(0).max(1073741824),
			type: z.string().min(1).max(100),
		})
		.optional(),
};

export const moveBodySchema = z
	.looseObject(moveShape)
	.superRefine((value, ctx) => {
		rejectUnknownKeys(Object.keys(moveShape), REPORT_MESSAGES.UNKNOWN_FIELD)(
			value,
			ctx,
		);
		if (value.status !== "done") {
			if (value.completionNote !== undefined) {
				ctx.addIssue({
					code: "custom",
					path: ["completionNote"],
					message: TASK_MESSAGES.NOTE_WITH_DONE,
				});
			}
			if (value.completionFile !== undefined) {
				ctx.addIssue({
					code: "custom",
					path: ["completionFile"],
					message: TASK_MESSAGES.FILE_WITH_DONE,
				});
			}
		}
	});
export type MoveBody = z.infer<z.ZodObject<typeof moveShape>>;
