import type {
	ReportAttachment,
	ReportContentSnapshot,
	ReportEventKind,
	ReportKpi,
	ReportLocation,
	ReportRow,
} from "./report.model";

/** @info - Mirrors `ReportDraft` in the frontend's src/data/reports.ts. Ids are strings. */
export interface ReportDraftDto {
	id: string;
	periodId: string;
	authorMembershipId: string;
	accomplishments: string;
	challenges: string;
	plans: string;
	kpis: ReportKpi[];
	attachments: (ReportAttachment & { uploaded: false })[];
	taggedMembershipIds: string[];
	location: ReportLocation | null;
	submissionStatus: "draft" | "submitted" | "late";
	reviewStatus: "pending" | "approved" | "rejected";
	updatedAt: string;
}

export interface RevisionContentDto {
	accomplishments: string;
	challenges: string;
	plans: string;
	kpis: ReportKpi[];
	attachments: (ReportAttachment & { uploaded: false })[];
	taggedMembershipIds: string[];
	location: ReportLocation | null;
}

/** @info - Mirrors `Report`. `comments` is always [] until the review slice. */
export interface ReportDto extends ReportDraftDto {
	submittedAt: string;
	firstSeenAt: string | null;
	windowStartedAt: string | null;
	editWindowMinutes: number;
	revisions: { at: string; previous: RevisionContentDto }[];
	events: { kind: ReportEventKind; at: string; actorMembershipId: string }[];
	comments: [];
}

/* @info - Metadata only, nothing is uploaded in this slice (D14). */
const attachmentsDto = (list: ReportAttachment[]) =>
	list.map((a) => ({
		name: a.name,
		size: a.size,
		type: a.type,
		uploaded: false as const,
	}));

export const toContentDto = (c: ReportContentSnapshot): RevisionContentDto => ({
	accomplishments: c.accomplishments,
	challenges: c.challenges,
	plans: c.plans,
	kpis: c.kpis,
	attachments: attachmentsDto(c.attachments),
	taggedMembershipIds: c.taggedMembershipIds.map(String),
	location: c.location,
});

export const toDraftDto = (r: ReportRow): ReportDraftDto => ({
	id: String(r.id),
	periodId: String(r.periodId),
	authorMembershipId: String(r.authorMembershipId),
	...toContentDto(r),
	submissionStatus: r.submissionStatus,
	reviewStatus: r.reviewStatus,
	updatedAt: r.updatedAt.toISOString(),
});

export const toReportDto = (
	r: ReportRow,
	revisions: { createdAt: Date; previous: ReportContentSnapshot }[],
	events: {
		kind: ReportEventKind;
		createdAt: Date;
		actorMembershipId: number;
	}[],
): ReportDto => ({
	...toDraftDto(r),
	submittedAt: (r.submittedAt as Date).toISOString(),
	firstSeenAt: r.firstSeenAt?.toISOString() ?? null,
	windowStartedAt: r.windowStartedAt?.toISOString() ?? null,
	editWindowMinutes: r.editWindowMinutes,
	revisions: revisions.map((v) => ({
		at: v.createdAt.toISOString(),
		previous: toContentDto(v.previous),
	})),
	events: events.map((e) => ({
		kind: e.kind,
		at: e.createdAt.toISOString(),
		actorMembershipId: String(e.actorMembershipId),
	})),
	comments: [],
});

export const snapshotOf = (r: ReportRow): ReportContentSnapshot => ({
	accomplishments: r.accomplishments,
	challenges: r.challenges,
	plans: r.plans,
	kpis: r.kpis,
	attachments: r.attachments,
	taggedMembershipIds: r.taggedMembershipIds,
	location: r.location ?? null,
});
