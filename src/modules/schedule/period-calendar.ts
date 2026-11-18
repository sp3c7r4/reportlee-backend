/**
 * @info - Pure reporting-period calendar (design D5 to D9). No database, no clock: every function
 * takes `now` or an instant. Time zones go through `Intl` only (D2), and civil dates are
 * "YYYY-MM-DD" strings worked with `Date.UTC` day arithmetic, so DST lives in `civilToInstant`.
 */

export type Cadence =
	| "daily"
	| "weekly"
	| "fortnightly"
	| "monthly"
	| "quarterly";

export interface CalendarVersion {
	cadence: Cadence;
	/** @info - English weekday name for weekly and fortnightly, else null. */
	weekday: string | null;
	time: string;
	timeZone: string;
	dayOfMonth: number | null;
	lastDay: boolean;
	/** @info - Fortnightly only: the first period start date of the version (D6). */
	anchorDate: string | null;
	effectiveFrom: Date;
}

export interface PeriodSpec {
	label: string;
	startsAt: Date;
	endsAt: Date;
	dueAt: Date;
}

/** @info - `effective_from` of the baseline row. A baseline version has no stub (D6). */
export const BASELINE_FROM = new Date("1970-01-01T00:00:00Z");
/** @info - R2: late submissions are accepted for 168 fixed hours, the same value as the frontend `SUBMISSION_WINDOW_MS`. */
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/* @info - Bound for the walk back in openPeriods (D8). */
const MAX_OPEN_WALK = 40;
const DAY_MS = 86_400_000;

export const WEEKDAYS = [
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
] as const;

/* ---------- civil dates ---------- */

const toDays = (date: string): number => {
	const [y, m, d] = date.split("-").map(Number);
	return Date.UTC(y as number, (m as number) - 1, d as number) / DAY_MS;
};
const fromDays = (days: number): string =>
	new Date(days * DAY_MS).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => fromDays(toDays(date) + n);
/** @info - ISO weekday, Monday 1 to Sunday 7. */
const isoWeekday = (date: string) => {
	const day = new Date(toDays(date) * DAY_MS).getUTCDay();
	return day === 0 ? 7 : day;
};
const ymd = (y: number, m: number, d: number) =>
	`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const daysInMonth = (y: number, m: number) =>
	new Date(Date.UTC(y, m, 0)).getUTCDate();

/* ---------- time zones ---------- */

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (timeZone: string) => {
	let f = formatters.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(timeZone, f);
	}
	return f;
};
const wallParts = (instant: number, timeZone: string) => {
	const parts: Record<string, number> = {};
	for (const p of formatter(timeZone).formatToParts(new Date(instant))) {
		if (p.type !== "literal") parts[p.type] = Number(p.value);
	}
	return {
		y: parts.year as number,
		m: parts.month as number,
		d: parts.day as number,
		h: (parts.hour as number) % 24,
		mi: parts.minute as number,
		s: parts.second as number,
	};
};
/** @info - Zone offset in ms at an instant (local wall clock minus UTC). */
const offsetAt = (instant: number, timeZone: string) => {
	const w = wallParts(instant, timeZone);
	const whole = Math.floor(instant / 1000) * 1000;
	return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - whole;
};

/** @info - The local civil date of an instant in a zone. */
export const localDate = (instant: Date, timeZone: string): string => {
	const w = wallParts(instant.getTime(), timeZone);
	return ymd(w.y, w.m, w.d);
};

/**
 * @info - The instant a local wall time names (D5). A time skipped by a clock change resolves to
 * the first wall time after the gap (the transition instant). An ambiguous time resolves to the
 * earlier instant.
 */
export const civilToInstant = (
	date: string,
	hhmm: string,
	timeZone: string,
): Date => {
	const [h, mi] = hhmm.split(":").map(Number);
	const local =
		toDays(date) * DAY_MS + (h as number) * 3_600_000 + (mi as number) * 60_000;
	const offsets = new Set([
		offsetAt(local - DAY_MS, timeZone),
		offsetAt(local, timeZone),
		offsetAt(local + DAY_MS, timeZone),
	]);
	const valid = [...offsets]
		.map((o) => local - o)
		.filter((t) => offsetAt(t, timeZone) === local - t);
	if (valid.length > 0) return new Date(Math.min(...valid));
	/* @info - In a gap: search the transition between the two candidate instants, to the second. */
	const sorted = [...offsets].sort((a, b) => a - b);
	let lo = local - (sorted.at(-1) as number);
	let hi = local - (sorted[0] as number);
	if (lo > hi) [lo, hi] = [hi, lo];
	const before = offsetAt(lo, timeZone);
	while (hi - lo > 1000) {
		const mid = Math.floor((lo + hi) / 2000) * 1000;
		if (mid <= lo) break;
		if (offsetAt(mid, timeZone) === before) lo = mid;
		else hi = mid;
	}
	return new Date(hi);
};

/* ---------- boundaries per cadence (D6) ---------- */

const monthBoundary = (v: CalendarVersion, y: number, m: number) => {
	const last = daysInMonth(y, m);
	const day = v.lastDay ? last : Math.min(v.dayOfMonth ?? 1, last);
	return ymd(y, m, day);
};
const shiftMonth = (y: number, m: number, n: number) => {
	const index = y * 12 + (m - 1) + n;
	return { y: Math.floor(index / 12), m: (index % 12) + 1 };
};

/** @info - The boundary date at or before `date`, and the one after it. */
export const boundaryDates = (
	v: CalendarVersion,
	date: string,
): { start: string; next: string } => {
	switch (v.cadence) {
		case "daily":
			return { start: date, next: addDays(date, 1) };
		case "weekly": {
			const w = WEEKDAYS.indexOf(v.weekday as (typeof WEEKDAYS)[number]) + 1;
			const start = addDays(date, -((isoWeekday(date) - w + 7) % 7));
			return { start, next: addDays(start, 7) };
		}
		case "fortnightly": {
			const anchor = toDays(v.anchorDate ?? date);
			const k = Math.floor((toDays(date) - anchor) / 14);
			const start = fromDays(anchor + 14 * k);
			return { start, next: addDays(start, 14) };
		}
		case "monthly":
		case "quarterly": {
			const step = v.cadence === "monthly" ? 1 : 3;
			const [y, m] = date.split("-").map(Number) as [number, number];
			const firstMonth = step === 1 ? m : Math.floor((m - 1) / 3) * 3 + 1;
			let cur = { y, m: firstMonth };
			if (date < monthBoundary(v, cur.y, cur.m))
				cur = shiftMonth(cur.y, cur.m, -step);
			const nxt = shiftMonth(cur.y, cur.m, step);
			return {
				start: monthBoundary(v, cur.y, cur.m),
				next: monthBoundary(v, nxt.y, nxt.m),
			};
		}
	}
};

/** @info - The first date on `weekday` on or after the local date of `effectiveFrom` (D6, A2). */
export const fortnightAnchor = (
	effectiveFrom: Date,
	weekday: string,
	timeZone: string,
): string => {
	const date = localDate(effectiveFrom, timeZone);
	const w = WEEKDAYS.indexOf(weekday as (typeof WEEKDAYS)[number]) + 1;
	return addDays(date, (w - isoWeekday(date) + 7) % 7);
};

/* ---------- labels ---------- */

const formatDate = (date: string, options: Intl.DateTimeFormatOptions) =>
	new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options }).format(
		new Date(toDays(date) * DAY_MS),
	);

/** @info - Labelled by the period's local start date in the schedule zone, so a stub is named by where it starts. */
export const periodLabel = (
	cadence: Cadence,
	startsAt: Date,
	timeZone: string,
): string => {
	const date = localDate(startsAt, timeZone);
	switch (cadence) {
		case "daily":
			return formatDate(date, {
				weekday: "long",
				day: "numeric",
				month: "long",
			});
		case "weekly":
			return `Week of ${formatDate(date, { day: "numeric", month: "long" })}`;
		case "fortnightly":
			return `Fortnight of ${formatDate(date, { day: "numeric", month: "long" })}`;
		case "monthly":
			return formatDate(date, { month: "long", year: "numeric" });
		case "quarterly":
			return `Quarter starting ${formatDate(date, { day: "numeric", month: "long", year: "numeric" })}`;
	}
};

/* ---------- periods ---------- */

const byEffective = (versions: CalendarVersion[]) =>
	[...versions].sort(
		(a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
	);

/**
 * @info - The period that contains `instant`, under the latest version effective at that instant.
 * The first period of a non-baseline version starts at its `effectiveFrom` (a stub). A period
 * never runs past the next version's `effectiveFrom`.
 */
export const periodContaining = (
	instant: Date,
	versions: CalendarVersion[],
): PeriodSpec => {
	const sorted = byEffective(versions);
	let index = -1;
	for (let i = 0; i < sorted.length; i += 1) {
		if (
			(sorted[i] as CalendarVersion).effectiveFrom.getTime() <=
			instant.getTime()
		)
			index = i;
	}
	if (index < 0) throw new Error("no schedule version covers this instant");
	const v = sorted[index] as CalendarVersion;
	const following = sorted[index + 1];
	const { start, next } = boundaryDates(v, localDate(instant, v.timeZone));
	let startsAt = civilToInstant(start, "00:00", v.timeZone);
	if (
		v.effectiveFrom.getTime() !== BASELINE_FROM.getTime() &&
		startsAt.getTime() < v.effectiveFrom.getTime()
	) {
		startsAt = v.effectiveFrom;
	}
	let nextStart = civilToInstant(next, "00:00", v.timeZone);
	let dueDate = next;
	if (following && following.effectiveFrom.getTime() < nextStart.getTime()) {
		nextStart = following.effectiveFrom;
		dueDate = localDate(nextStart, v.timeZone);
	}
	return {
		label: periodLabel(v.cadence, startsAt, v.timeZone),
		startsAt,
		endsAt: new Date(nextStart.getTime() - 1000),
		dueAt: civilToInstant(dueDate, v.time, v.timeZone),
	};
};

/** @info - D9: closed once `now` is past `dueAt` plus the fixed grace. */
export const isClosed = (period: Pick<PeriodSpec, "dueAt">, now: Date) =>
	now.getTime() > period.dueAt.getTime() + GRACE_MS;

const walkOpen = (now: Date, versions: CalendarVersion[]): PeriodSpec[] => {
	const out: PeriodSpec[] = [];
	let p = periodContaining(now, versions);
	const earliest = byEffective(versions)[0]?.effectiveFrom.getTime() ?? 0;
	for (let i = 0; i < MAX_OPEN_WALK; i += 1) {
		if (isClosed(p, now)) break;
		out.push(p);
		const before = p.startsAt.getTime() - 1;
		if (before < earliest) break;
		p = periodContaining(new Date(before), versions);
	}
	return out.reverse();
};

/**
 * @info - D7: the earliest open period whose deadline has not passed, else the one containing
 * `now`. A request at exactly `dueAt` still sees the earlier period (a submission then is on time).
 */
export const currentPeriod = (
	now: Date,
	versions: CalendarVersion[],
): PeriodSpec =>
	walkOpen(now, versions).find((p) => p.dueAt.getTime() >= now.getTime()) ??
	periodContaining(now, versions);

/**
 * @info - D8: every started period still inside its grace, oldest `dueAt` first. `notBefore` (the
 * Workspace creation time) drops periods that ended before the Workspace existed; the current
 * period is always kept.
 */
export const openPeriods = (
	now: Date,
	versions: CalendarVersion[],
	notBefore?: Date,
): PeriodSpec[] => {
	const current = currentPeriod(now, versions);
	return walkOpen(now, versions)
		.filter(
			(p) =>
				!notBefore ||
				p.endsAt.getTime() >= notBefore.getTime() ||
				p.startsAt.getTime() === current.startsAt.getTime(),
		)
		.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
};

/** @info - A6: the first boundary of the active version strictly after `now`. Pending versions are ignored. */
export const nextPeriodStart = (
	now: Date,
	versions: CalendarVersion[],
): Date => {
	const active = versions.filter(
		(v) => v.effectiveFrom.getTime() <= now.getTime(),
	);
	const p = periodContaining(now, active);
	return new Date(p.endsAt.getTime() + 1000);
};
