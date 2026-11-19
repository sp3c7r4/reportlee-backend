import { and, eq, inArray } from "drizzle-orm";
import { config } from "@/config";
import { getReader } from "@/db/postgres.db";
import { EmailTemplates, NotificationType } from "@/enums";
import { EmailJobNames } from "@/enums/queue";
import { redactEmails } from "@/helpers/log-redact.helper";
import { isActiveMember } from "@/modules/membership/active";
import { memberships } from "@/modules/membership/membership.model";
import { reports } from "@/modules/report/report.model";
import { spaces } from "@/modules/space/space.model";
import { users } from "@/modules/user/user.model";
import { workspaces } from "@/modules/workspace/workspace.model";
import { EmailQueueService } from "@/services/queues/email.queue.service";
import { serviceLogger } from "@/utils";
import { DECISION_EMAIL, REVIEW_NOTICES } from "./notification.message";
import { NotificationService } from "./notification.service";

interface Recipient {
	membershipId: number;
	userId: number;
	firstName: string;
	email: string;
}

const reportHref = (reportId: number) => `/dashboard/reports/${reportId}`;

/**
 * @info - V7 (D17). Called after the business transaction commits. Recipients are Memberships,
 * mapped to users here. A Membership that is not active at send time is skipped (design review
 * finding 10). Every failure is logged with ids only and never reaches the request.
 */
export class ReviewNotifier {
	private static instance: ReviewNotifier;
	private readonly log = serviceLogger("ReviewNotifier");
	private readonly notifications = NotificationService.getInstance();
	static getInstance() {
		if (!this.instance) this.instance = new ReviewNotifier();
		return this.instance;
	}
	private constructor() {}

	private recipients = async (
		workspaceId: number,
		membershipIds: number[],
	): Promise<Recipient[]> => {
		if (membershipIds.length === 0) return [];
		return getReader()
			.select({
				membershipId: memberships.id,
				userId: users.id,
				firstName: users.firstName,
				email: users.email,
			})
			.from(memberships)
			.innerJoin(users, eq(users.id, memberships.userId))
			.where(
				and(
					eq(memberships.workspaceId, workspaceId),
					inArray(memberships.id, membershipIds),
					isActiveMember(),
				),
			);
	};

	/**
	 * @info - The designated reviewers, by the same V1 rule as `ReportAccess.relation`: the Space's
	 * Head, or every active Admin when the Space has no Head or the author is a Head.
	 */
	reviewersOf = async (reportId: number): Promise<number[]> => {
		const db = getReader();
		const [row] = await db
			.select({
				workspaceId: reports.workspaceId,
				head: spaces.headMembershipId,
				authorId: reports.authorMembershipId,
				authorRole: memberships.role,
			})
			.from(reports)
			.innerJoin(spaces, eq(spaces.id, reports.spaceId))
			.innerJoin(memberships, eq(memberships.id, reports.authorMembershipId))
			.where(eq(reports.id, reportId))
			.limit(1);
		if (!row) return [];
		if (row.head && row.authorRole !== "head" && row.head !== row.authorId) {
			return [row.head];
		}
		const admins = await db
			.select({ id: memberships.id })
			.from(memberships)
			.innerJoin(users, eq(users.id, memberships.userId))
			.where(
				and(
					eq(memberships.workspaceId, row.workspaceId),
					eq(memberships.role, "admin"),
					isActiveMember(),
				),
			);
		return admins.map((a) => a.id).filter((id) => id !== row.authorId);
	};

	private send = async (
		workspaceId: number,
		membershipIds: number[],
		type: NotificationType,
		notice: { title: string; message: string },
		reportId: number,
	) => {
		try {
			const people = await this.recipients(workspaceId, membershipIds);
			for (const p of people) {
				await this.notifications.notify(
					p.userId,
					type,
					notice.title,
					notice.message,
					{ reportId: String(reportId) },
					{
						workspaceId,
						membershipId: p.membershipId,
						href: reportHref(reportId),
					},
				);
			}
		} catch (error) {
			this.log.error(
				`Notification ${type} for report ${reportId} failed: ${redactEmails((error as Error).message)}`,
			);
		}
	};

	/** @info - A decision goes to the author. Approve and reject also queue an email (V8). */
	decision = async (input: {
		workspaceId: number;
		reportId: number;
		authorMembershipId: number;
		kind: "approved" | "rejected" | "reopened";
		eventId: number;
	}) => {
		await this.send(
			input.workspaceId,
			[input.authorMembershipId],
			NotificationType.DECISION,
			REVIEW_NOTICES[input.kind],
			input.reportId,
		);
		if (input.kind !== "reopened") {
			await this.decisionEmail({ ...input, kind: input.kind });
		}
	};

	/**
	 * @info - D18. The address is read here, after commit, and goes only into the Redis job (the
	 * queue needs it at enqueue time). Logs carry the report id and job name only.
	 */
	private decisionEmail = async (input: {
		workspaceId: number;
		reportId: number;
		authorMembershipId: number;
		kind: "approved" | "rejected";
		eventId: number;
	}) => {
		if (!config.decisionEmailsEnabled) return;
		try {
			const [author] = await this.recipients(input.workspaceId, [
				input.authorMembershipId,
			]);
			if (!author) return;
			const [ws] = await getReader()
				.select({ name: workspaces.name })
				.from(workspaces)
				.where(eq(workspaces.id, input.workspaceId))
				.limit(1);
			const text = DECISION_EMAIL[input.kind];
			await EmailQueueService.getInstance().add(
				EmailJobNames.DECISION as never,
				{
					message: { to: author.email, subject: text.subject },
					template: EmailTemplates.DECISION,
					locals: {
						name: author.firstName,
						title: text.title,
						body: text.body,
						reportUrl: `${config.frontendUrl}${reportHref(input.reportId)}`,
						workspaceName: ws?.name ?? "Reportlee",
					},
					idempotencyKey: `decision:${input.eventId}`,
				},
				{ removeOnComplete: true, removeOnFail: { age: 86400 } },
			);
		} catch (error) {
			this.log.warn(
				`Decision email not queued for report ${input.reportId} (job ${EmailJobNames.DECISION}): ${redactEmails((error as Error).message)}`,
			);
		}
	};

	/** @info - A reviewer comment goes to the author; an author reply goes to the reviewers. */
	comment = async (input: {
		workspaceId: number;
		reportId: number;
		authorMembershipId: number;
		byAuthor: boolean;
	}) => {
		if (input.byAuthor) {
			const reviewers = await this.reviewersOf(input.reportId).catch(() => []);
			await this.send(
				input.workspaceId,
				reviewers,
				NotificationType.COMMENT,
				REVIEW_NOTICES.replyToReviewer,
				input.reportId,
			);
			return;
		}
		await this.send(
			input.workspaceId,
			[input.authorMembershipId],
			NotificationType.COMMENT,
			REVIEW_NOTICES.commentToAuthor,
			input.reportId,
		);
	};

	/** @info - A submission goes to the reviewers. */
	submission = async (input: { workspaceId: number; reportId: number }) => {
		const reviewers = await this.reviewersOf(input.reportId).catch(() => []);
		await this.send(
			input.workspaceId,
			reviewers,
			NotificationType.SUBMISSION,
			REVIEW_NOTICES.submission,
			input.reportId,
		);
	};

	/** @info - A task goes to the assignee. */
	task = async (input: {
		workspaceId: number;
		reportId: number;
		assigneeMembershipId: number;
	}) => {
		await this.send(
			input.workspaceId,
			[input.assigneeMembershipId],
			NotificationType.TASK,
			REVIEW_NOTICES.task,
			input.reportId,
		);
	};
}
