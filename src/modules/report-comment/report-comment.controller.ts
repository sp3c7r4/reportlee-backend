import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers/response";
import { validatedBody } from "@/helpers/validated";
import { callerId } from "@/middlewares/auth/workspace-guards";
import { ReviewNotifier } from "@/modules/notifications/report-events";
import { ReportCommentService } from "./report-comment.service";

/* @info - `{ log: false }`: comment bodies are personal data and untrusted text (AC25). */
const quiet = { log: false } as const;

export class ReportCommentController {
	private static instance: ReportCommentController;
	private readonly service = ReportCommentService.getInstance();
	private readonly notifier = ReviewNotifier.getInstance();
	static getInstance() {
		if (!this.instance) this.instance = new ReportCommentController();
		return this.instance;
	}
	private constructor() {}

	add = async (c: Context) => {
		const result = await this.service.add(
			callerId(c),
			Number(c.req.param("id")),
			validatedBody(c),
			new Date(),
		);
		/* @info - After commit (D17). The notifier never throws. */
		await this.notifier.comment({
			workspaceId: result.workspaceId,
			reportId: result.reportId,
			authorMembershipId: result.authorMembershipId,
			byAuthor: !result.byReviewer,
		});
		if (result.task) {
			await this.notifier.task({
				workspaceId: result.workspaceId,
				reportId: result.reportId,
				assigneeMembershipId: result.task.assigneeMembershipId,
			});
		}
		return sendSuccessResponse(c, result.comment, StatusCodes.CREATED, quiet);
	};
}
