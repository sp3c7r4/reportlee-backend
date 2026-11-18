import type { Tx } from "@/db/postgres.db";
import { CodedConflictError, CodedForbiddenError } from "@/errors";
import type { Caller } from "@/modules/membership/membership.service";
import { findWorkspace } from "@/modules/workspace/workspace.repository";
import { REPORT_CODES, REPORT_MESSAGES } from "./report.message";
import type { ReportRow } from "./report.model";
import {
	findLiveReport,
	lockLiveReport,
	membershipRole,
	spaceHead,
} from "./report.repository";
import { notFound, resolveOrNotFound } from "./scope";

export type Relation = "author" | "reviewer" | "none";
export interface Access {
	report: ReportRow;
	caller: Caller;
	relation: Relation;
}

const forbid = (
	key: keyof typeof REPORT_CODES & keyof typeof REPORT_MESSAGES,
): never => {
	throw new CodedForbiddenError(REPORT_MESSAGES[key], REPORT_CODES[key]);
};
const conflict = (
	key: keyof typeof REPORT_CODES & keyof typeof REPORT_MESSAGES,
): never => {
	throw new CodedConflictError(REPORT_MESSAGES[key], REPORT_CODES[key]);
};

/**
 * @info - THE choke point for who may read, submit, edit and delete a report (design "ReportAccess").
 * Every report route goes through one of the assert methods; the review slice adds assertReview
 * here. Rules run in the binding "Order of checks". Submit, edit and delete run on the row locked
 * FOR UPDATE inside the caller's transaction.
 */
export class ReportAccess {
	private static instance: ReportAccess;
	static getInstance() {
		if (!this.instance) this.instance = new ReportAccess();
		return this.instance;
	}
	private constructor() {}

	/**
	 * @info - Pure (R3, D10). Approved is locked. Rejected is always editable. Otherwise a seen
	 * report locks once `now` passes the window. Returns the lock code, or null when editable.
	 */
	static editState = (
		report: Pick<
			ReportRow,
			"reviewStatus" | "firstSeenAt" | "windowStartedAt" | "editWindowMinutes"
		>,
		now: Date,
	): "REPORT_APPROVED" | "EDIT_WINDOW_CLOSED" | null => {
		if (report.reviewStatus === "approved") return "REPORT_APPROVED";
		if (report.reviewStatus === "rejected") return null;
		if (
			report.firstSeenAt &&
			report.windowStartedAt &&
			now.getTime() >
				report.windowStartedAt.getTime() + report.editWindowMinutes * 60_000
		) {
			return "EDIT_WINDOW_CLOSED";
		}
		return null;
	};

	/**
	 * @info - `reviewersFor` in the frontend, applied literally (A7, A9): the current Head of the
	 * report's Space, or an Admin when that Space has no Head or the author is a Head. Drafts have
	 * no reviewer.
	 */
	relation = async (
		tx: Tx,
		caller: Caller,
		report: ReportRow,
	): Promise<Relation> => {
		if (caller.membershipId === report.authorMembershipId) return "author";
		if (report.submissionStatus === "draft") return "none";
		const space = await spaceHead(tx, report.spaceId);
		if (space?.head === caller.membershipId) return "reviewer";
		if (caller.role === "admin") {
			if (space?.head === null || space?.head === undefined) return "reviewer";
			if ((await membershipRole(tx, report.authorMembershipId)) === "head") {
				return "reviewer";
			}
		}
		return "none";
	};

	/** @info - Missing, deleted, other Workspace, non-member, deactivated: one 404. Suspended: 401. */
	load = async (
		tx: Tx,
		userId: number,
		reportId: number,
		lock: boolean,
	): Promise<Access> => {
		const report = lock
			? await lockLiveReport(tx, reportId)
			: await findLiveReport(tx, reportId);
		if (!report) return notFound();
		const caller = await resolveOrNotFound(userId, report.workspaceId);
		return {
			report,
			caller,
			relation: await this.relation(tx, caller, report),
		};
	};

	/** @info - D17: the role is read from the current Membership row, never from the request. */
	assertAuthorRole = (caller: Caller) => {
		if (caller.role === "admin") forbid("ADMIN_CANNOT_AUTHOR");
	};

	/** @info - D17: only Staff and Heads author, and never in a read-only Workspace. */
	assertCanAuthor = async (tx: Tx, caller: Caller) => {
		this.assertAuthorRole(caller);
		const workspace = await findWorkspace(tx, caller.workspaceId);
		if (!workspace) return notFound();
		if (workspace.readOnly) forbid("WORKSPACE_READ_ONLY");
		return workspace;
	};

	private assertAuthor = (access: Access) => {
		if (access.relation === "none") notFound();
		if (access.relation === "reviewer") forbid("NOT_AUTHOR");
	};

	/** @info - E9. A draft is served only by E5 (D24), so it is 404 here for everyone. */
	assertRead = async (tx: Tx, userId: number, reportId: number) => {
		const access = await this.load(tx, userId, reportId, false);
		if (
			access.report.submissionStatus === "draft" ||
			access.relation === "none"
		) {
			return notFound();
		}
		return access;
	};

	/** @info - E7 steps 1 to 5 (carry-over 2). The service then checks the period and the text. */
	assertSubmit = async (tx: Tx, userId: number, reportId: number) => {
		const access = await this.load(tx, userId, reportId, true);
		this.assertAuthor(access);
		const workspace = await this.assertCanAuthor(tx, access.caller);
		if (access.report.submissionStatus !== "draft")
			conflict("ALREADY_SUBMITTED");
		return { ...access, workspace };
	};

	/** @info - E10 steps 1 to 7. The service then checks the resulting content. */
	assertEdit = async (tx: Tx, userId: number, reportId: number, now: Date) => {
		const access = await this.load(tx, userId, reportId, true);
		this.assertAuthor(access);
		const workspace = await this.assertCanAuthor(tx, access.caller);
		if (access.report.submissionStatus === "draft") conflict("NOT_SUBMITTED");
		const lockCode = ReportAccess.editState(access.report, now);
		if (lockCode) forbid(lockCode);
		return { ...access, workspace };
	};

	/** @info - E11. Delete is allowed in a read-only Workspace (D17) and only while unseen (R3). */
	assertDelete = async (tx: Tx, userId: number, reportId: number) => {
		const access = await this.load(tx, userId, reportId, true);
		this.assertAuthor(access);
		if (
			access.report.firstSeenAt ||
			access.report.reviewStatus === "approved"
		) {
			forbid("REPORT_SEEN");
		}
		return access;
	};
}
