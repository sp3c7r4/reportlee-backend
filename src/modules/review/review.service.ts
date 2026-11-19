import { HTTPException } from "hono/http-exception";
import { getDb, getReader, type Tx } from "@/db/postgres.db";
import { CodedConflictError, CodedForbiddenError, FieldError } from "@/errors";
import { AuditLogService } from "@/modules/audit/audit-log.service";
import type { ReportDto } from "@/modules/report/report.dto";
import type { ReportEventKind } from "@/modules/report/report.model";
import {
	insertEvent,
	markSeen,
	updateReport,
} from "@/modules/report/report.repository";
import { ReportService } from "@/modules/report/report.service";
import { ReportAccess } from "@/modules/report/report-access";
import { notFound, resolveOrNotFound } from "@/modules/report/scope";
import { plainText } from "@/modules/report-comment/comment-sanitizer";
import { insertComment } from "@/modules/report-comment/report-comment.repository";
import { findPeriodById } from "@/modules/schedule/schedule.repository";
import { logger } from "@/utils";
import { REASON_MAX, REVIEW_CODES, REVIEW_MESSAGES } from "./review.message";
import {
	headedSpaceIds,
	missingMembers,
	queueReports,
} from "./review.repository";
import type {
	BulkBody,
	Decision,
	DecisionBody,
	QueueQuery,
} from "./review.schema";

const EVENT_FOR: Record<Decision, ReportEventKind> = {
	approve: "approved",
	reject: "rejected",
	reopen: "reopened",
};
const STATUS_FOR = {
	approve: "approved",
	reject: "rejected",
	reopen: "pending",
} as const;

export interface MissingRow {
	membershipId: string;
	name: string;
	role: "staff" | "head";
	space: string | null;
	submitted: false;
	hasDraft: boolean;
}

/**
 * @info - E13 step 9. Approve takes an optional reason: stored when it is non-empty after
 * sanitizing, ignored when it is empty. Reject and reopen need 1 to 1000 characters. Lengths are
 * counted on the decoded plain text (D13).
 */
const reasonFor = (
	decision: Decision,
	raw: string | undefined,
): string | null => {
	if (decision === "approve") {
		if (raw === undefined) return null;
		const text = plainText(raw);
		if (text.length > REASON_MAX) {
			throw new FieldError({ reason: REVIEW_MESSAGES.REASON_TOO_LONG });
		}
		return text === "" ? null : text;
	}
	const text = raw === undefined ? "" : plainText(raw);
	if (text.length < 1 || text.length > REASON_MAX) {
		throw new FieldError({ reason: REVIEW_MESSAGES.REASON_REQUIRED });
	}
	return text;
};

/** @info - What a bulk skip row says: the stable code of the rule that refused it. */
const skipCode = (e: unknown): string => {
	if (e instanceof CodedForbiddenError || e instanceof CodedConflictError) {
		return e.code;
	}
	if (e instanceof HTTPException && e.status === 404)
		return REVIEW_CODES.NOT_FOUND;
	/* @info - Code and report id only. The error text can hold SQL and the body is personal data. */
	return REVIEW_CODES.INTERNAL;
};

export class ReviewService {
	private static instance: ReviewService;
	private readonly access = ReportAccess.getInstance();
	private readonly reports = ReportService.getInstance();
	private readonly audit = AuditLogService.getInstance();
	static getInstance() {
		if (!this.instance) this.instance = new ReviewService();
		return this.instance;
	}
	private constructor() {}

	/**
	 * @info - One decision in the caller's transaction. `assertDecide` locks the row, so the state
	 * it checks is the state this transaction writes over. A designated reviewer's decision counts
	 * as a look (D12); an Admin who is not the designated reviewer never starts the author's
	 * window, and reopen clears it.
	 */
	private decideIn = async (
		tx: Tx,
		userId: number,
		reportId: number,
		body: DecisionBody,
		now: Date,
		workspaceId?: number,
	) => {
		const { report, caller, relation } = await this.access.assertDecide(
			tx,
			userId,
			reportId,
			body.decision,
			workspaceId,
		);
		const reason = reasonFor(body.decision, body.reason);
		const seen = await markSeen(tx, report, caller.membershipId, now, {
			startWindow: relation === "reviewer" && body.decision !== "reopen",
			event: "first",
		});
		const row = await updateReport(tx, seen.id, {
			reviewStatus: STATUS_FOR[body.decision],
			...(body.decision === "reopen" && { windowStartedAt: null }),
			updatedAt: now,
		});
		const eventId = await insertEvent(
			tx,
			row.id,
			EVENT_FOR[body.decision],
			caller.membershipId,
			now,
		);
		if (reason !== null) {
			await insertComment(tx, {
				reportId: row.id,
				authorMembershipId: caller.membershipId,
				kind: "decision",
				body: reason,
				createdAt: now,
			});
		}
		await this.audit.record(tx, {
			workspaceId: caller.workspaceId,
			actorMembershipId: caller.membershipId,
			action: body.decision === "reopen" ? "report.reopened" : "report.decided",
			target: `report:${row.id}`,
			summary: `Report ${row.id} ${EVENT_FOR[body.decision]}`,
		});
		return { row, caller, eventId, decision: body.decision };
	};

	/** @info - E13. */
	decide = async (
		userId: number,
		reportId: number,
		body: DecisionBody,
		now: Date,
	): Promise<ReportDto> =>
		getDb().transaction(async (tx) => {
			const { row } = await this.decideIn(tx, userId, reportId, body, now);
			return this.reports.one(tx, row);
		});

	/** @info - E15. Staff are refused before anything else is read. */
	queue = async (userId: number, query: QueueQuery) => {
		const caller = await resolveOrNotFound(userId, Number(query.workspaceId));
		if (caller.role === "staff") {
			throw new CodedForbiddenError(
				REVIEW_MESSAGES.NOT_REVIEWER,
				REVIEW_CODES.NOT_REVIEWER,
			);
		}
		const db = getReader();
		const period = await findPeriodById(db, Number(query.periodId));
		if (!period || period.workspaceId !== caller.workspaceId) return notFound();
		const scope = {
			workspaceId: caller.workspaceId,
			periodId: period.id,
			callerMembershipId: caller.membershipId,
			spaceIds:
				caller.role === "admin"
					? null
					: await headedSpaceIds(db, caller.membershipId),
		};
		const [rows, missing] = await Promise.all([
			queueReports(db, scope),
			missingMembers(db, scope),
		]);
		return {
			reports: await this.reports.withHistory(db, rows),
			missing: missing.map(
				(m): MissingRow => ({
					membershipId: String(m.membershipId),
					name: `${m.firstName} ${m.lastName}`.trim(),
					role: m.role,
					space: m.space,
					submitted: false,
					hasDraft: m.hasDraft,
				}),
			),
		};
	};

	/**
	 * @info - E16. Ids are sorted so two simultaneous bulk runs lock in the same order. Each id is
	 * its own transaction through the same `assertDecide`, so a refusal skips that id and never
	 * aborts the batch.
	 */
	bulkApprove = async (userId: number, body: BulkBody, now: Date) => {
		const caller = await resolveOrNotFound(userId, Number(body.workspaceId));
		if (caller.role !== "admin") {
			throw new CodedForbiddenError(
				REVIEW_MESSAGES.BULK_ADMIN_ONLY,
				REVIEW_CODES.NOT_REVIEWER,
			);
		}
		const ids = [...new Set(body.reportIds.map(Number))].sort((a, b) => a - b);
		const approved: string[] = [];
		const skipped: { id: string; code: string }[] = [];
		for (const id of ids) {
			try {
				await getDb().transaction((tx) =>
					this.decideIn(
						tx,
						userId,
						id,
						{ decision: "approve" },
						now,
						caller.workspaceId,
					),
				);
				approved.push(String(id));
			} catch (e) {
				const code = skipCode(e);
				if (code === REVIEW_CODES.INTERNAL) {
					logger.error(`Bulk approve failed for report ${id}`);
				}
				skipped.push({ id: String(id), code });
			}
		}
		return { approved, skipped };
	};
}
