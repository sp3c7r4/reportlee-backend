/**
 * @info - D31: first int of `pg_advisory_xact_lock(PERIOD_LOCK_CLASS, workspaceId)`. Taken only to
 * create a period or the baseline, by PUT schedule, and by a Workspace update that sends
 * `timeZone`. Always before any Workspace row lock.
 */
export const PERIOD_LOCK_CLASS = 41001;
/** @info - HH:MM from 00:00 to 23:59. The same text is the CHECK in 0002_reports.sql. */
export const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
/** @info - R1 default Schedule. */
export const DEFAULT_SCHEDULE = {
	cadence: "weekly",
	weekday: "Monday",
	time: "17:00",
} as const;
