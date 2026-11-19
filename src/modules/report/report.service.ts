import { getDb, getReader, type Tx } from "@/db/postgres.db";
import { CodedConflictError, FieldError } from "@/errors";
import { AuditLogService } from "@/modules/audit/audit-log.service";
import type { Caller } from "@/modules/membership/membership.service";
import { isClosed } from "@/modules/schedule/period-calendar";
import type { ReportingPeriodRow } from "@/modules/schedule/schedule.model";
import { findPeriodById } from "@/modules/schedule/schedule.repository";
import {
	type ReportDraftDto,
	type ReportDto,
	snapshotOf,
	toDraftDto,
	toReportDto,
} from "./report.dto";
import { REPORT_CODES, REPORT_MESSAGES } from "./report.message";
import type { NewReportRow, ReportKpi, ReportRow } from "./report.model";
import {
	activeMemberIds,
	eventsFor,
	findLiveFor,
	insertDraftIfMissing,
	insertEvent,
	insertRevision,
	listOwn,
	lockLiveFor,
	markSeen,
	revisionsFor,
	spaceHead,
	updateReport,
} from "./report.repository";
import type {
	ContentBody,
	DraftBody,
	EditBody,
	ListQuery,
} from "./report.schema";
import { ReportAccess } from "./report-access";
import {
	ACCOMPLISHMENTS_MIN,
	htmlToText,
	SECTION_MAX,
	sanitizeReportHtml,
} from "./report-sanitizer";
import { notFound, resolveOrNotFound } from "./scope";

const SECTIONS = ["accomplishments", "challenges", "plans"] as const;
type Section = (typeof SECTIONS)[number];

const conflict = (
	key: keyof typeof REPORT_CODES & keyof typeof REPORT_MESSAGES,
): never => {
	throw new CodedConflictError(REPORT_MESSAGES[key], REPORT_CODES[key]);
};

/** @info - Sanitised, length-checked sections that were sent. Runs before any length rule (AC21). */
const cleanSections = (body: ContentBody): Partial<Record<Section, string>> => {
	const out: Partial<Record<Section, string>> = {};
	const errors: Record<string, string> = {};
	for (const key of SECTIONS) {
		const raw = body[key];
		if (raw === undefined) continue;
		try {
			const clean = sanitizeReportHtml(raw);
			if (htmlToText(clean).length > SECTION_MAX) {
				errors[key] = REPORT_MESSAGES.SECTION_MAX;
			} else {
				out[key] = clean;
			}
		} catch {
			errors[key] = REPORT_MESSAGES.RAW_TOO_LONG;
		}
	}
	if (Object.keys(errors).length > 0) throw new FieldError(errors);
	return out;
};

/** @info - D15: active Memberships of this Workspace, not the author. Tags grant no access. */
const checkTags = async (tx: Tx, caller: Caller, ids: string[] | undefined) => {
	if (ids === undefined) return undefined;
	const numbers = ids.map(Number);
	const active = await activeMemberIds(tx, caller.workspaceId, numbers);
	if (numbers.some((id) => id === caller.membershipId || !active.has(id))) {
		throw new FieldError({ taggedMembershipIds: REPORT_MESSAGES.TAGS_INVALID });
	}
	return numbers;
};

/**
 * @info - D13: the client can only set a value on a snapshot row, matched by name. With two rows
 * of one name the first gets the value. Unknown names are ignored.
 */
const mergeKpis = (
	stored: ReportKpi[],
	sent: { name: string; value: number | null }[] | undefined,
): ReportKpi[] => {
	if (sent === undefined) return stored;
	const next = stored.map((k) => ({ ...k }));
	for (const row of sent) {
		const target = next.find((k) => k.name === row.name);
		if (target) target.value = row.value;
	}
	return next;
};

/** @info - The content columns a body changes, merged onto the stored row. */
const contentUpdate = (
	report: ReportRow,
	body: ContentBody,
	sections: Partial<Record<Section, string>>,
	tags: number[] | undefined,
): Partial<NewReportRow> => ({
	...sections,
	kpis: mergeKpis(report.kpis, body.kpis),
	...(body.attachments !== undefined && {
		attachments: body.attachments.map((a) => ({
			name: a.name,
			size: a.size,
			type: a.type,
		})),
	}),
	...(tags !== undefined && { taggedMembershipIds: tags }),
	...(body.location !== undefined && { location: body.location }),
});

const assertAccomplishments = (html: string) => {
	if (htmlToText(html).length < ACCOMPLISHMENTS_MIN) {
		throw new FieldError({
			accomplishments: REPORT_MESSAGES.ACCOMPLISHMENTS_MIN,
		});
	}
};

export class ReportService {
	private static instance: ReportService;
	private readonly access = ReportAccess.getInstance();
	private readonly audit = AuditLogService.getInstance();
	static getInstance() {
		if (!this.instance) this.instance = new ReportService();
		return this.instance;
	}
	private constructor() {}

	/** @info - E5 and E6 step 1: the period decides the Workspace (D19). */
	private periodScope = async (userId: number, periodId: number) => {
		const period = await findPeriodById(getReader(), periodId);
		if (!period) return notFound();
		const caller = await resolveOrNotFound(userId, period.workspaceId);
		return { period, caller };
	};

	private assertHasSpace = (caller: Caller): number => {
		if (caller.spaceId === null) return conflict("NO_SPACE");
		return caller.spaceId;
	};

	private withHistory = async (
		tx: Tx,
		rows: ReportRow[],
	): Promise<ReportDto[]> => {
		const ids = rows.map((r) => r.id);
		const [revisions, events] = await Promise.all([
			revisionsFor(tx, ids),
			eventsFor(tx, ids),
		]);
		return rows.map((r) =>
			toReportDto(
				r,
				revisions.filter((v) => v.reportId === r.id),
				events.filter((e) => e.reportId === r.id),
			),
		);
	};

	private one = async (tx: Tx, row: ReportRow) =>
		(await this.withHistory(tx, [row]))[0] as ReportDto;

	/** @info - E5. The caller's live draft, or null when there is none or it is submitted (D24b). */
	getDraft = async (
		userId: number,
		periodId: number,
	): Promise<ReportDraftDto | null> => {
		const { period, caller } = await this.periodScope(userId, periodId);
		this.access.assertAuthorRole(caller);
		this.assertHasSpace(caller);
		const row = await findLiveFor(getReader(), period.id, caller.membershipId);
		return row && row.submissionStatus === "draft" ? toDraftDto(row) : null;
	};

	/** @info - E6, in the binding order of checks (D30). */
	saveDraft = async (userId: number, body: DraftBody, now: Date) => {
		const { period, caller } = await this.periodScope(
			userId,
			Number(body.periodId),
		);
		this.access.assertAuthorRole(caller);
		const spaceId = this.assertHasSpace(caller);
		const workspace = await this.access.assertCanAuthor(getReader(), caller);
		this.assertPeriodOpen(period, now);
		const sections = cleanSections(body);
		return getDb().transaction(async (tx) => {
			const tags = await checkTags(tx, caller, body.taggedMembershipIds);
			const space = await spaceHead(tx, spaceId);
			await insertDraftIfMissing(tx, {
				workspaceId: caller.workspaceId,
				periodId: period.id,
				authorMembershipId: caller.membershipId,
				spaceId,
				kpis: (space?.kpiTemplate ?? []).map((k) => ({
					name: k.name,
					unit: k.unit,
					value: null,
				})),
				editWindowMinutes: workspace.editWindowMinutes,
				createdAt: now,
				updatedAt: now,
			});
			const row = await lockLiveFor(tx, period.id, caller.membershipId);
			if (!row) return notFound();
			if (row.submissionStatus !== "draft")
				return conflict("ALREADY_SUBMITTED");
			const values = contentUpdate(row, body, sections, tags);
			return toDraftDto(
				await updateReport(tx, row.id, { ...values, updatedAt: now }),
			);
		});
	};

	/** @info - D9. Before the start is defensive: periods that have not started are never created. */
	private assertPeriodOpen = (period: ReportingPeriodRow, now: Date) => {
		if (now.getTime() < period.startsAt.getTime()) conflict("PERIOD_NOT_OPEN");
		if (isClosed(period, now)) conflict("PERIOD_CLOSED");
	};

	/** @info - E7. All checks run on the row locked in this transaction. */
	submit = async (
		userId: number,
		reportId: number,
		now: Date,
	): Promise<ReportDto> =>
		getDb().transaction(async (tx) => {
			const { report, caller, workspace } = await this.access.assertSubmit(
				tx,
				userId,
				reportId,
			);
			const period = await findPeriodById(tx, report.periodId);
			if (!period) return notFound();
			if (isClosed(period, now)) conflict("PERIOD_CLOSED");
			assertAccomplishments(report.accomplishments);
			const row = await updateReport(tx, report.id, {
				submissionStatus:
					now.getTime() > period.dueAt.getTime() ? "late" : "submitted",
				submittedAt: now,
				reviewStatus: "pending",
				editWindowMinutes: workspace.editWindowMinutes,
				updatedAt: now,
			});
			await insertEvent(tx, row.id, "submitted", caller.membershipId, now);
			await this.audit.record(tx, {
				workspaceId: caller.workspaceId,
				actorMembershipId: caller.membershipId,
				action: "report.submitted",
				target: `report:${row.id}`,
				summary: `Report ${row.id} ${row.submissionStatus}`,
			});
			return this.one(tx, row);
		});

	/** @info - E10 (R3). Each edit stores the previous content, returns to pending and clears the window (A1). */
	edit = async (userId: number, reportId: number, body: EditBody, now: Date) =>
		getDb().transaction(async (tx) => {
			const { report, caller } = await this.access.assertEdit(
				tx,
				userId,
				reportId,
				now,
			);
			const sections = cleanSections(body);
			assertAccomplishments(sections.accomplishments ?? report.accomplishments);
			const tags = await checkTags(tx, caller, body.taggedMembershipIds);
			await insertRevision(tx, report.id, snapshotOf(report), now);
			const values = contentUpdate(report, body, sections, tags);
			const row = await updateReport(tx, report.id, {
				...values,
				reviewStatus: "pending",
				windowStartedAt: null,
				updatedAt: now,
			});
			await insertEvent(tx, row.id, "edited", caller.membershipId, now);
			await this.audit.record(tx, {
				workspaceId: caller.workspaceId,
				actorMembershipId: caller.membershipId,
				action: "report.edited",
				target: `report:${row.id}`,
				summary: `Changed: ${Object.keys(body).join(", ")}`,
			});
			return this.one(tx, row);
		});

	/** @info - E11. Soft delete frees the period for a new draft (D11). */
	remove = async (userId: number, reportId: number, now: Date) =>
		getDb().transaction(async (tx) => {
			const { report, caller } = await this.access.assertDelete(
				tx,
				userId,
				reportId,
			);
			await updateReport(tx, report.id, { deletedAt: now, updatedAt: now });
			await this.audit.record(tx, {
				workspaceId: caller.workspaceId,
				actorMembershipId: caller.membershipId,
				action: "report.deleted",
				target: `report:${report.id}`,
				summary: `Report ${report.id} deleted`,
			});
		});

	/** @info - E12. D10, D11: idempotent, so a repeat call returns the stored times. */
	seen = async (userId: number, reportId: number, now: Date) =>
		getDb().transaction(async (tx) => {
			const { report, caller } = await this.access.assertSeen(
				tx,
				userId,
				reportId,
			);
			const row = await markSeen(tx, report, caller.membershipId, now, {
				startWindow: true,
				event: "window",
			});
			return {
				firstSeenAt: (row.firstSeenAt as Date).toISOString(),
				windowStartedAt: (row.windowStartedAt as Date).toISOString(),
			};
		});

	/** @info - E9. */
	read = async (userId: number, reportId: number): Promise<ReportDto> => {
		const db = getReader();
		const { report } = await this.access.assertRead(db, userId, reportId);
		return this.one(db, report);
	};

	/** @info - E8. The caller's own reports only, an Admin included. */
	list = async (userId: number, query: ListQuery) => {
		const caller = await resolveOrNotFound(userId, Number(query.workspaceId));
		const db = getReader();
		const rows = await listOwn(db, caller.membershipId, {
			periodId:
				query.periodId === undefined ? undefined : Number(query.periodId),
			drafts: query.status === "draft",
			limit: query.limit,
			offset: query.offset,
		});
		return query.status === "draft"
			? rows.map(toDraftDto)
			: this.withHistory(db, rows);
	};
}
