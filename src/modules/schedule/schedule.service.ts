import { getDb, getReader } from "@/db/postgres.db";
import { AuditLogService } from "@/modules/audit/audit-log.service";
import type { Caller } from "@/modules/membership/membership.service";
import { notFound } from "@/modules/report/scope";
import { findWorkspace } from "@/modules/workspace/workspace.repository";
import {
	BASELINE_FROM,
	type CalendarVersion,
	currentPeriod,
	fortnightAnchor,
	nextPeriodStart,
	openPeriods,
	type PeriodSpec,
} from "./period-calendar";
import {
	type ApiScheduleDto,
	type ReportingPeriodDto,
	type ScheduleFieldsDto,
	toPeriodDto,
} from "./schedule.dto";
import type {
	ReportingPeriodRow,
	WorkspaceScheduleRow,
} from "./schedule.model";
import {
	deletePendingVersions,
	ensureBaseline,
	findPeriodById,
	findPeriodsByStart,
	insertPeriodIfMissing,
	insertVersion,
	listVersions,
	lockPeriods,
} from "./schedule.repository";
import type { ScheduleBody } from "./schedule.schema";

const toVersion = (row: WorkspaceScheduleRow): CalendarVersion => ({
	cadence: row.cadence,
	weekday: row.weekday,
	time: row.timeOfDay,
	timeZone: row.timeZone,
	dayOfMonth: row.dayOfMonth,
	lastDay: row.lastDay,
	anchorDate: row.anchorDate,
	effectiveFrom: row.effectiveFrom,
});

/** @info - R1: the Schedule a Workspace has before any row is written. */
const defaultVersion = (timeZone: string): CalendarVersion => ({
	cadence: "weekly",
	weekday: "Monday",
	time: "17:00",
	timeZone,
	dayOfMonth: null,
	lastDay: false,
	anchorDate: null,
	effectiveFrom: BASELINE_FROM,
});

const toFields = (v: CalendarVersion): ScheduleFieldsDto => ({
	cadence: v.cadence,
	weekday: v.weekday ?? "",
	time: v.time,
	timeZone: v.timeZone,
	dayOfMonth: v.dayOfMonth,
	lastDay: v.lastDay,
});

const isBaseline = (v: CalendarVersion) =>
	v.effectiveFrom.getTime() === BASELINE_FROM.getTime();

const toApiSchedule = (
	versions: CalendarVersion[],
	now: Date,
): ApiScheduleDto => {
	const active = versions
		.filter((v) => v.effectiveFrom.getTime() <= now.getTime())
		.at(-1) as CalendarVersion;
	const pending = versions.find(
		(v) => v.effectiveFrom.getTime() > now.getTime(),
	);
	return {
		...toFields(active),
		effectiveFrom: isBaseline(active)
			? null
			: active.effectiveFrom.toISOString(),
		pending: pending
			? {
					...toFields(pending),
					effectiveFrom: pending.effectiveFrom.toISOString(),
				}
			: null,
	};
};

export class ScheduleService {
	private static instance: ScheduleService;
	private readonly audit = AuditLogService.getInstance();
	static getInstance() {
		if (!this.instance) this.instance = new ScheduleService();
		return this.instance;
	}
	private constructor() {}

	/** @info - Stored versions, oldest first, or the R1 default when none is stored. Writes nothing. */
	private versions = async (workspaceId: number) => {
		const db = getReader();
		const workspace = await findWorkspace(db, workspaceId);
		if (!workspace) return notFound();
		const rows = await listVersions(db, workspaceId);
		return {
			workspace,
			versions:
				rows.length > 0
					? rows.map(toVersion)
					: [defaultVersion(workspace.timeZone)],
		};
	};

	/** @info - E1. Any active member (route guard). */
	get = async (caller: Caller, now: Date): Promise<ApiScheduleDto> => {
		const { versions } = await this.versions(caller.workspaceId);
		return toApiSchedule(versions, now);
	};

	/**
	 * @info - E2. Admin only (route guard). Under the period lock: write the baseline if missing,
	 * replace any pending version with one starting at the next period (R1, A6). Never edits a
	 * stored period.
	 */
	put = async (caller: Caller, body: ScheduleBody, now: Date) =>
		getDb().transaction(async (tx) => {
			await lockPeriods(tx, caller.workspaceId);
			await ensureBaseline(tx, caller.workspaceId, now);
			const before = (await listVersions(tx, caller.workspaceId)).map(
				toVersion,
			);
			const effectiveFrom = nextPeriodStart(now, before);
			await deletePendingVersions(tx, caller.workspaceId, now);
			const weekly =
				body.cadence === "weekly" || body.cadence === "fortnightly";
			const monthly =
				body.cadence === "monthly" || body.cadence === "quarterly";
			const lastDay = monthly ? (body.lastDay ?? false) : false;
			const weekday = weekly ? (body.weekday ?? null) : null;
			await insertVersion(tx, {
				workspaceId: caller.workspaceId,
				cadence: body.cadence,
				weekday,
				timeOfDay: body.time,
				timeZone: body.timeZone,
				dayOfMonth: monthly && !lastDay ? (body.dayOfMonth ?? null) : null,
				lastDay,
				anchorDate:
					body.cadence === "fortnightly" && weekday
						? fortnightAnchor(effectiveFrom, weekday, body.timeZone)
						: null,
				effectiveFrom,
				createdByMembershipId: caller.membershipId,
				createdAt: now,
				updatedAt: now,
			});
			await this.audit.record(tx, {
				workspaceId: caller.workspaceId,
				actorMembershipId: caller.membershipId,
				action: "schedule.change",
				target: `workspace:${caller.workspaceId}`,
				summary: `Schedule changed: ${Object.keys(body).join(", ")}`,
			});
			const after = (await listVersions(tx, caller.workspaceId)).map(toVersion);
			return {
				...toApiSchedule(after, now),
				appliesFrom: effectiveFrom.toISOString(),
			};
		});

	/**
	 * @info - Returns the stored rows for the specs `pick` chooses, creating the missing ones under
	 * the period lock (D31). A stored row always wins over a recomputed one.
	 */
	private materialise = async (
		workspaceId: number,
		pick: (versions: CalendarVersion[]) => PeriodSpec[],
		now: Date,
	): Promise<ReportingPeriodRow[]> => {
		const order = (specs: PeriodSpec[], rows: ReportingPeriodRow[]) => {
			const byStart = new Map(rows.map((r) => [r.startsAt.getTime(), r]));
			return specs.flatMap((s) => {
				const row = byStart.get(s.startsAt.getTime());
				return row ? [row] : [];
			});
		};
		const { versions } = await this.versions(workspaceId);
		const specs = pick(versions).filter(
			(s) => s.startsAt.getTime() <= now.getTime(),
		);
		const found = order(
			specs,
			await findPeriodsByStart(
				getReader(),
				workspaceId,
				specs.map((s) => s.startsAt),
			),
		);
		if (found.length === specs.length) return found;
		return getDb().transaction(async (tx) => {
			await lockPeriods(tx, workspaceId);
			await ensureBaseline(tx, workspaceId, now);
			const locked = (await listVersions(tx, workspaceId)).map(toVersion);
			const lockedSpecs = pick(locked).filter(
				(s) => s.startsAt.getTime() <= now.getTime(),
			);
			for (const spec of lockedSpecs) {
				await insertPeriodIfMissing(tx, workspaceId, spec, now);
			}
			return order(
				lockedSpecs,
				await findPeriodsByStart(
					tx,
					workspaceId,
					lockedSpecs.map((s) => s.startsAt),
				),
			);
		});
	};

	/** @info - E3 (D7). */
	current = async (caller: Caller, now: Date): Promise<ReportingPeriodDto> => {
		const [row] = await this.materialise(
			caller.workspaceId,
			(versions) => [currentPeriod(now, versions)],
			now,
		);
		if (!row) return notFound();
		return toPeriodDto(row);
	};

	/**
	 * @info - E4 (D8). A period that ended before the Workspace was created is not open (design
	 * review carry-over 3), except the current period.
	 */
	open = async (caller: Caller, now: Date): Promise<ReportingPeriodDto[]> => {
		const workspace = await findWorkspace(getReader(), caller.workspaceId);
		if (!workspace) return notFound();
		const rows = await this.materialise(
			caller.workspaceId,
			(versions) => openPeriods(now, versions, workspace.createdAt),
			now,
		);
		return rows.map(toPeriodDto);
	};

	/** @info - For the report module: a stored period by id, or null. */
	periodById = async (periodId: number) =>
		findPeriodById(getReader(), periodId);
}
