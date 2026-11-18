import type { Cadence } from "./period-calendar";
import type { ReportingPeriodRow } from "./schedule.model";

/** @info - Mirrors `ReportingPeriod` in the frontend's src/data/reports.ts. */
export interface ReportingPeriodDto {
	id: string;
	label: string;
	startsAt: string;
	endsAt: string;
	dueAt: string;
}

/** @info - Mirrors `Schedule` in the frontend's src/lib/settings.ts. */
export interface ScheduleFieldsDto {
	cadence: Cadence;
	/** @info - English name, "" when the cadence does not use it. */
	weekday: string;
	time: string;
	timeZone: string;
	dayOfMonth: number | null;
	lastDay: boolean;
}

/** @info - `ApiSchedule` in design.md. `effectiveFrom` is null for the baseline version. */
export interface ApiScheduleDto extends ScheduleFieldsDto {
	effectiveFrom: string | null;
	pending: (ScheduleFieldsDto & { effectiveFrom: string }) | null;
}

export const toPeriodDto = (row: ReportingPeriodRow): ReportingPeriodDto => ({
	id: String(row.id),
	label: row.label,
	startsAt: row.startsAt.toISOString(),
	endsAt: row.endsAt.toISOString(),
	dueAt: row.dueAt.toISOString(),
});
