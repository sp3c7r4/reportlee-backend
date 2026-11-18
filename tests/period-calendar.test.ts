/** Pure calendar rules (design D5 to D9). Every expected instant is computed by hand. */
import { describe, expect, it } from "vitest";
import {
	BASELINE_FROM,
	type CalendarVersion,
	civilToInstant,
	currentPeriod,
	fortnightAnchor,
	GRACE_MS,
	isClosed,
	nextPeriodStart,
	openPeriods,
	periodContaining,
} from "@/modules/schedule/period-calendar";

const v = (overrides: Partial<CalendarVersion>): CalendarVersion => ({
	cadence: "weekly",
	weekday: "Monday",
	time: "17:00",
	timeZone: "Africa/Lagos",
	dayOfMonth: null,
	lastDay: false,
	anchorDate: null,
	effectiveFrom: BASELINE_FROM,
	...overrides,
});
const at = (iso: string) => new Date(iso);
const iso = (p: { startsAt: Date; endsAt: Date; dueAt: Date }) => ({
	startsAt: p.startsAt.toISOString(),
	endsAt: p.endsAt.toISOString(),
	dueAt: p.dueAt.toISOString(),
});
const HOUR = 3_600_000;

describe("civilToInstant", () => {
	it("maps a plain wall time with the zone offset", () => {
		expect(
			civilToInstant("2026-10-26", "17:00", "Africa/Lagos").toISOString(),
		).toBe("2026-10-26T16:00:00.000Z");
	});
	it("moves a time inside a spring-forward gap to the first wall time after it", () => {
		expect(
			civilToInstant("2027-03-14", "02:30", "America/New_York").toISOString(),
		).toBe("2027-03-14T07:00:00.000Z");
	});
	it("takes the earlier instant of an ambiguous fall-back time", () => {
		expect(
			civilToInstant("2026-11-01", "01:30", "America/New_York").toISOString(),
		).toBe("2026-11-01T05:30:00.000Z");
	});
	it("resolves a skipped midnight (Africa/Cairo, last Friday of April) to 01:00 local", () => {
		const t = civilToInstant("2026-04-24", "00:00", "Africa/Cairo");
		expect(t.toISOString()).toBe("2026-04-23T22:00:00.000Z");
		const local = new Intl.DateTimeFormat("en-GB", {
			timeZone: "Africa/Cairo",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).format(t);
		expect(local).toBe("01:00");
	});
});

describe("five cadences in Africa/Lagos (no DST)", () => {
	it("weekly Monday 17:00 matches SAMPLE_PERIOD", () => {
		const p = periodContaining(at("2026-10-21T12:00:00Z"), [v({})]);
		expect(iso(p)).toEqual({
			startsAt: "2026-10-18T23:00:00.000Z",
			endsAt: "2026-10-25T22:59:59.000Z",
			dueAt: "2026-10-26T16:00:00.000Z",
		});
		expect(p.label).toBe("Week of 19 October");
	});
	it("daily", () => {
		const p = periodContaining(at("2026-10-21T12:00:00Z"), [
			v({ cadence: "daily", weekday: null, time: "09:00" }),
		]);
		expect(iso(p)).toEqual({
			startsAt: "2026-10-20T23:00:00.000Z",
			endsAt: "2026-10-21T22:59:59.000Z",
			dueAt: "2026-10-22T08:00:00.000Z",
		});
		expect(p.label).toBe("Wednesday 21 October");
	});
	it("fortnightly counts 14 days from the anchor", () => {
		const version = v({
			cadence: "fortnightly",
			weekday: "Friday",
			anchorDate: "2026-11-06",
			effectiveFrom: at("2026-11-05T23:00:00Z"),
		});
		const p = periodContaining(at("2026-11-25T12:00:00Z"), [version]);
		expect(iso(p)).toEqual({
			startsAt: "2026-11-19T23:00:00.000Z",
			endsAt: "2026-12-03T22:59:59.000Z",
			dueAt: "2026-12-04T16:00:00.000Z",
		});
		expect(p.label).toBe("Fortnight of 20 November");
		const next = periodContaining(at("2026-12-04T12:00:00Z"), [version]);
		expect(next.startsAt.getTime() - p.startsAt.getTime()).toBe(14 * 24 * HOUR);
	});
	it("monthly on day 15", () => {
		const p = periodContaining(at("2026-10-20T12:00:00Z"), [
			v({ cadence: "monthly", weekday: null, dayOfMonth: 15 }),
		]);
		expect(iso(p)).toEqual({
			startsAt: "2026-10-14T23:00:00.000Z",
			endsAt: "2026-11-14T22:59:59.000Z",
			dueAt: "2026-11-15T16:00:00.000Z",
		});
		expect(p.label).toBe("October 2026");
	});
	it("monthly on day 31 clamps to 29 February in a leap year", () => {
		const p = periodContaining(at("2028-02-10T12:00:00Z"), [
			v({ cadence: "monthly", weekday: null, dayOfMonth: 31 }),
		]);
		expect(p.startsAt.toISOString()).toBe("2028-01-30T23:00:00.000Z");
		expect(p.dueAt.toISOString()).toBe("2028-02-29T16:00:00.000Z");
	});
	it("monthly on day 31 clamps to 28 February in a non-leap year", () => {
		const p = periodContaining(at("2027-03-05T12:00:00Z"), [
			v({ cadence: "monthly", weekday: null, dayOfMonth: 31 }),
		]);
		expect(iso(p)).toEqual({
			startsAt: "2027-02-27T23:00:00.000Z",
			endsAt: "2027-03-30T22:59:59.000Z",
			dueAt: "2027-03-31T16:00:00.000Z",
		});
	});
	it("monthly on the last day", () => {
		const p = periodContaining(at("2026-04-10T12:00:00Z"), [
			v({ cadence: "monthly", weekday: null, lastDay: true }),
		]);
		expect(p.startsAt.toISOString()).toBe("2026-03-30T23:00:00.000Z");
		expect(p.dueAt.toISOString()).toBe("2026-04-30T16:00:00.000Z");
		expect(p.label).toBe("March 2026");
	});
	it("quarterly rolls from October into January", () => {
		const version = v({ cadence: "quarterly", weekday: null, dayOfMonth: 1 });
		const p = periodContaining(at("2026-12-15T12:00:00Z"), [version]);
		expect(iso(p)).toEqual({
			startsAt: "2026-09-30T23:00:00.000Z",
			endsAt: "2026-12-31T22:59:59.000Z",
			dueAt: "2027-01-01T16:00:00.000Z",
		});
		expect(p.label).toBe("Quarter starting 1 October 2026");
		const jan = periodContaining(at("2027-01-20T12:00:00Z"), [version]);
		expect(jan.startsAt.toISOString()).toBe("2026-12-31T23:00:00.000Z");
	});
});

describe("daylight saving changes", () => {
	it("America/New_York fall-back week is 169 hours, due 17:00 EST", () => {
		const p = periodContaining(at("2026-10-28T12:00:00Z"), [
			v({ timeZone: "America/New_York" }),
		]);
		expect(iso(p)).toEqual({
			startsAt: "2026-10-26T04:00:00.000Z",
			endsAt: "2026-11-02T04:59:59.000Z",
			dueAt: "2026-11-02T22:00:00.000Z",
		});
		expect(p.endsAt.getTime() + 1000 - p.startsAt.getTime()).toBe(169 * HOUR);
	});
	it("America/New_York spring-forward week is 167 hours, due 17:00 EDT", () => {
		const p = periodContaining(at("2027-03-10T12:00:00Z"), [
			v({ timeZone: "America/New_York" }),
		]);
		expect(iso(p)).toEqual({
			startsAt: "2027-03-08T05:00:00.000Z",
			endsAt: "2027-03-15T03:59:59.000Z",
			dueAt: "2027-03-15T21:00:00.000Z",
		});
	});
	it("Europe/London week across 29 March 2026", () => {
		const p = periodContaining(at("2026-03-25T12:00:00Z"), [
			v({ timeZone: "Europe/London" }),
		]);
		expect(iso(p)).toEqual({
			startsAt: "2026-03-23T00:00:00.000Z",
			endsAt: "2026-03-29T22:59:59.000Z",
			dueAt: "2026-03-30T16:00:00.000Z",
		});
	});
	it("Africa/Cairo daily: the day whose midnight is skipped starts at 01:00 and lasts 23 hours", () => {
		const p = periodContaining(at("2026-04-24T10:00:00Z"), [
			v({ cadence: "daily", weekday: null, timeZone: "Africa/Cairo" }),
		]);
		expect(p.startsAt.toISOString()).toBe("2026-04-23T22:00:00.000Z");
		expect(p.endsAt.toISOString()).toBe("2026-04-24T20:59:59.000Z");
		expect(p.label).toBe("Friday 24 April");
	});
	it("the grace is 168 fixed hours, not 7 calendar days, across a DST change", () => {
		const p = periodContaining(at("2026-10-30T12:00:00Z"), [
			v({ cadence: "daily", weekday: null, timeZone: "America/New_York" }),
		]);
		expect(p.dueAt.toISOString()).toBe("2026-10-31T21:00:00.000Z");
		const close = new Date(p.dueAt.getTime() + GRACE_MS);
		expect(close.toISOString()).toBe("2026-11-07T21:00:00.000Z");
		expect(isClosed(p, close)).toBe(false);
		expect(isClosed(p, new Date(close.getTime() + 1))).toBe(true);
	});
});

describe("current and open periods (D7, D8)", () => {
	const versions = [v({})];
	it("is the week of 19 October on Monday 26 October 15:30 and at exactly 17:00:00.000", () => {
		expect(currentPeriod(at("2026-10-26T14:30:00Z"), versions).label).toBe(
			"Week of 19 October",
		);
		expect(currentPeriod(at("2026-10-26T16:00:00.000Z"), versions).label).toBe(
			"Week of 19 October",
		);
	});
	it("is the week of 26 October from 17:00:00.001 and at 17:01", () => {
		expect(currentPeriod(at("2026-10-26T16:00:00.001Z"), versions).label).toBe(
			"Week of 26 October",
		);
		expect(currentPeriod(at("2026-10-26T16:01:00Z"), versions).label).toBe(
			"Week of 26 October",
		);
	});
	it("lists every started period still inside its grace, oldest first", () => {
		const open = openPeriods(at("2026-10-28T11:00:00Z"), versions);
		expect(open.map((p) => iso(p))).toEqual([
			{
				startsAt: "2026-10-18T23:00:00.000Z",
				endsAt: "2026-10-25T22:59:59.000Z",
				dueAt: "2026-10-26T16:00:00.000Z",
			},
			{
				startsAt: "2026-10-25T23:00:00.000Z",
				endsAt: "2026-11-01T22:59:59.000Z",
				dueAt: "2026-11-02T16:00:00.000Z",
			},
		]);
	});
	it("drops a period once now passes dueAt + 168 hours", () => {
		const open = openPeriods(at("2026-11-02T16:00:00.001Z"), versions);
		expect(open.map((p) => p.label)).toEqual([
			"Week of 26 October",
			"Week of 2 November",
		]);
		const edge = openPeriods(at("2026-11-02T16:00:00.000Z"), versions);
		expect(edge.map((p) => p.label)).toEqual([
			"Week of 19 October",
			"Week of 26 October",
			"Week of 2 November",
		]);
	});
	it("never lists a period that ended before notBefore, except the current one", () => {
		const created = at("2026-10-28T09:00:00Z");
		const open = openPeriods(at("2026-10-28T11:00:00Z"), versions, created);
		expect(open.map((p) => p.label)).toEqual(["Week of 26 October"]);
		const early = openPeriods(
			at("2026-10-26T14:30:00Z"),
			versions,
			at("2026-10-26T09:00:00Z"),
		);
		expect(early.map((p) => p.label)).toContain("Week of 19 October");
	});
	it("never lists a period that has not started", () => {
		const now = at("2026-10-28T11:00:00Z");
		for (const p of openPeriods(now, versions)) {
			expect(p.startsAt.getTime()).toBeLessThanOrEqual(now.getTime());
		}
	});
});

describe("schedule change applies from the next period (D6)", () => {
	const now = at("2026-10-28T11:00:00Z"); // Wednesday 28 October 12:00 Lagos
	const baseline = v({});
	it("next period start is the first boundary after now", () => {
		expect(nextPeriodStart(now, [baseline]).toISOString()).toBe(
			"2026-11-01T23:00:00.000Z",
		);
	});
	it("weekly Monday to weekly Friday: old period untouched, stub, then full weeks", () => {
		const effectiveFrom = nextPeriodStart(now, [baseline]);
		const versions = [baseline, v({ weekday: "Friday", effectiveFrom })];
		expect(iso(periodContaining(at("2026-10-28T11:00:00Z"), versions))).toEqual(
			{
				startsAt: "2026-10-25T23:00:00.000Z",
				endsAt: "2026-11-01T22:59:59.000Z",
				dueAt: "2026-11-02T16:00:00.000Z",
			},
		);
		const stub = periodContaining(at("2026-11-03T12:00:00Z"), versions);
		expect(iso(stub)).toEqual({
			startsAt: "2026-11-01T23:00:00.000Z",
			endsAt: "2026-11-05T22:59:59.000Z",
			dueAt: "2026-11-06T16:00:00.000Z",
		});
		expect(stub.label).toBe("Week of 2 November");
		const full = periodContaining(at("2026-11-08T12:00:00Z"), versions);
		expect(full.startsAt.toISOString()).toBe("2026-11-05T23:00:00.000Z");
		expect(full.endsAt.toISOString()).toBe("2026-11-12T22:59:59.000Z");
	});
	it("weekly to fortnightly Friday: anchor 6 November, stub, fortnights on 6 and 20 November", () => {
		const effectiveFrom = nextPeriodStart(now, [baseline]);
		const anchorDate = fortnightAnchor(effectiveFrom, "Friday", "Africa/Lagos");
		expect(anchorDate).toBe("2026-11-06");
		const versions = [
			baseline,
			v({
				cadence: "fortnightly",
				weekday: "Friday",
				anchorDate,
				effectiveFrom,
			}),
		];
		const stub = periodContaining(at("2026-11-03T12:00:00Z"), versions);
		expect(stub.endsAt.toISOString()).toBe("2026-11-05T22:59:59.000Z");
		expect(stub.label).toBe("Fortnight of 2 November");
		expect(
			periodContaining(
				at("2026-11-10T12:00:00Z"),
				versions,
			).startsAt.toISOString(),
		).toBe("2026-11-05T23:00:00.000Z");
		expect(
			periodContaining(
				at("2026-11-25T12:00:00Z"),
				versions,
			).startsAt.toISOString(),
		).toBe("2026-11-19T23:00:00.000Z");
	});
	it("Africa/Lagos to Africa/Cairo: the stub starts at the instant, not local midnight", () => {
		const effectiveFrom = nextPeriodStart(now, [baseline]);
		const versions = [baseline, v({ timeZone: "Africa/Cairo", effectiveFrom })];
		const stub = periodContaining(at("2026-11-03T12:00:00Z"), versions);
		expect(iso(stub)).toEqual({
			startsAt: "2026-11-01T23:00:00.000Z",
			endsAt: "2026-11-08T21:59:59.000Z",
			dueAt: "2026-11-09T15:00:00.000Z",
		});
		expect(stub.label).toBe("Week of 2 November");
	});
	it("monthly day 31 to quarterly day 1: stub from 31 October to 1 January", () => {
		const monthly = v({ cadence: "monthly", weekday: null, dayOfMonth: 31 });
		const t = at("2026-10-15T11:00:00Z");
		const effectiveFrom = nextPeriodStart(t, [monthly]);
		expect(effectiveFrom.toISOString()).toBe("2026-10-30T23:00:00.000Z");
		const versions = [
			monthly,
			v({ cadence: "quarterly", weekday: null, dayOfMonth: 1, effectiveFrom }),
		];
		const stub = periodContaining(at("2026-11-15T12:00:00Z"), versions);
		expect(iso(stub)).toEqual({
			startsAt: "2026-10-30T23:00:00.000Z",
			endsAt: "2026-12-31T22:59:59.000Z",
			dueAt: "2027-01-01T16:00:00.000Z",
		});
		expect(stub.label).toBe("Quarter starting 31 October 2026");
	});
	it("labels a daily and a monthly stub by their local start date", () => {
		const daily = periodContaining(at("2026-11-02T10:00:00Z"), [
			v({ cadence: "daily", weekday: null }),
			v({
				cadence: "daily",
				weekday: null,
				timeZone: "Africa/Cairo",
				effectiveFrom: at("2026-11-01T23:00:00Z"),
			}),
		]);
		expect(daily.label).toBe("Monday 2 November");
		const monthly = periodContaining(at("2026-10-20T10:00:00Z"), [
			baseline,
			v({
				cadence: "monthly",
				weekday: null,
				dayOfMonth: 1,
				effectiveFrom: at("2026-10-14T23:00:00Z"),
			}),
		]);
		expect(monthly.startsAt.toISOString()).toBe("2026-10-14T23:00:00.000Z");
		expect(monthly.label).toBe("October 2026");
	});
	it("current period with a stub shorter than a day is still the earliest period whose deadline has not passed", () => {
		const versions = [
			v({ cadence: "daily", weekday: null }),
			v({
				cadence: "daily",
				weekday: null,
				timeZone: "Africa/Cairo",
				time: "09:00",
				effectiveFrom: at("2026-11-01T23:00:00Z"),
			}),
		];
		const stub = periodContaining(at("2026-11-02T10:00:00Z"), versions);
		expect(stub.endsAt.getTime() + 1000 - stub.startsAt.getTime()).toBe(
			23 * HOUR,
		);
		expect(
			currentPeriod(
				at("2026-11-02T10:00:00Z"),
				versions,
			).startsAt.toISOString(),
		).toBe("2026-10-31T23:00:00.000Z");
		expect(
			currentPeriod(
				at("2026-11-02T16:00:00.001Z"),
				versions,
			).startsAt.toISOString(),
		).toBe("2026-11-01T23:00:00.000Z");
	});
});
