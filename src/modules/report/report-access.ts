import type { Tx } from "@/db/postgres.db";
import { CodedConflictError, CodedForbiddenError } from "@/errors";
import type { Caller } from "@/modules/membership/membership.service";
import { hasEntryFromOthers } from "@/modules/report-comment/report-comment.repository";
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

/* @info - "reviewer" is the designated reviewer (V1). "admin" is any other Admin of the Workspace
 * (V2): may read and decide, never marks seen and never starts a thread. */
export type Relation = "author" | "reviewer" | "admin" | "none";
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
	 * @info - V1, with the AUTHOR's role checked first: a Head's report always goes to the Admins,
	 * never to another Head, even the Head of the Space it was written in. Otherwise the current
	 * Head of the report's Space reviews, or the Admins when that Space has no Head. Any Admin who
	 * is not the designated reviewer gets "admin" (V2). Drafts have no reviewer.
	 */
	relation = async (
		tx: Tx,
		caller: Caller,
		report: ReportRow,
	): Promise<Relation> => {
		if (caller.membershipId === report.authorMembershipId) return "author";
		if (report.submissionStatus === "draft") return "none";
		const space = await spaceHead(tx, report.spaceId);
		const authorIsHead =
			(await membershipRole(tx, report.authorMembershipId)) === "head";
		const adminsReview = !space?.head || authorIsHead;
		if (!adminsReview && space?.head === caller.membershipId) return "reviewer";
		if (caller.role === "admin") return adminsReview ? "reviewer" : "admin";
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
		if (access.relation !== "author") forbid("NOT_AUTHOR");
	};

	/**
	 * @info - E12. Only the designated reviewer starts the author's lock (D9, D10). A draft is 404
	 * for everyone, the author included. The author and a non-designated Admin know the report
	 * exists, so they get 403. Runs on the row locked FOR UPDATE.
	 */
	assertSeen = async (tx: Tx, userId: number, reportId: number) => {
		const access = await this.load(tx, userId, reportId, true);
		if (access.report.submissionStatus === "draft") return notFound();
		if (access.relation === "none") return notFound();
		if (access.relation !== "reviewer") forbid("NOT_REVIEWER");
		return access;
	};

	/**
	 * @info - E13, the binding order (D1 to D3). Runs on the row locked FOR UPDATE, so two
	 * simultaneous decisions serialize and the second sees the new state. `workspaceId` is the bulk
	 * route's claim: a report of another Workspace is 404 even for an Admin who belongs to both.
	 * Staff and a Head who is not the designated reviewer get 404, so they learn nothing.
	 */
	assertDecide = async (
		tx: Tx,
		userId: number,
		reportId: number,
		decision: "approve" | "reject" | "reopen",
		workspaceId?: number,
	) => {
		const access = await this.load(tx, userId, reportId, true);
		const { report, caller, relation } = access;
		if (workspaceId !== undefined && report.workspaceId !== workspaceId) {
			return notFound();
		}
		if (report.submissionStatus === "draft") {
			if (relation === "author") conflict("DRAFT_CANNOT_DECIDE");
			return notFound();
		}
		if (relation === "author") forbid("NOT_AUTHOR_CANNOT_DECIDE");
		if (caller.role === "staff") return notFound();
		if (relation !== "reviewer" && relation !== "admin") return notFound();
		const workspace = await findWorkspace(tx, caller.workspaceId);
		if (!workspace) return notFound();
		if (workspace.readOnly) forbid("WORKSPACE_READ_ONLY");
		if (report.reviewStatus === "approved" && decision !== "reopen") {
			conflict("APPROVED_REOPEN_FIRST");
		}
		if (decision === "reopen" && report.reviewStatus !== "approved") {
			conflict("NOT_APPROVED");
		}
		return access;
	};

	/**
	 * @info - E14. State is NOT checked: an approved report still takes comments and tasks, because
	 * they do not change its content (design review, finding 3). The designated reviewer starts a
	 * thread. The author replies only after someone else wrote. A non-designated Admin is a reader.
	 */
	assertComment = async (tx: Tx, userId: number, reportId: number) => {
		const access = await this.load(tx, userId, reportId, true);
		if (access.report.submissionStatus === "draft") return notFound();
		if (access.relation === "none") return notFound();
		const workspace = await findWorkspace(tx, access.caller.workspaceId);
		if (!workspace) return notFound();
		if (workspace.readOnly) forbid("WORKSPACE_READ_ONLY");
		if (access.relation === "admin") forbid("NOT_REVIEWER_COMMENT");
		if (access.relation === "author") {
			const replied = await hasEntryFromOthers(
				tx,
				access.report.id,
				access.caller.membershipId,
			);
			if (!replied) forbid("REVIEWER_MUST_START");
		}
		return access;
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
