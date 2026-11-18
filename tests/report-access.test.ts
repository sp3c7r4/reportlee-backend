/** ReportAccess.editState (R3, D10): pure, no database. The HTTP rules are in reports.test.ts. */
import { describe, expect, it } from "vitest";
import { ReportAccess } from "@/modules/report/report-access";

const seenAt = new Date("2026-10-28T10:00:00.000Z");
const base = {
	reviewStatus: "pending" as const,
	firstSeenAt: null as Date | null,
	windowStartedAt: null as Date | null,
	editWindowMinutes: 30,
};
const after = (ms: number) => new Date(seenAt.getTime() + ms);
const MIN = 60_000;

describe("ReportAccess.editState", () => {
	it("keeps an unseen report editable however late it is", () => {
		expect(ReportAccess.editState(base, after(365 * 24 * 60 * MIN))).toBeNull();
	});
	it("keeps a seen report editable up to and at exactly the window end", () => {
		const seen = { ...base, firstSeenAt: seenAt, windowStartedAt: seenAt };
		expect(ReportAccess.editState(seen, after(10 * MIN))).toBeNull();
		expect(ReportAccess.editState(seen, after(30 * MIN))).toBeNull();
		expect(ReportAccess.editState(seen, after(30 * MIN + 1))).toBe(
			"EDIT_WINDOW_CLOSED",
		);
	});
	it("uses the report's own window length", () => {
		const seen = {
			...base,
			firstSeenAt: seenAt,
			windowStartedAt: seenAt,
			editWindowMinutes: 5,
		};
		expect(ReportAccess.editState(seen, after(6 * MIN))).toBe(
			"EDIT_WINDOW_CLOSED",
		);
	});
	it("treats a seen report with a cleared window as editable (each edit clears it, A1)", () => {
		const seen = { ...base, firstSeenAt: seenAt, windowStartedAt: null };
		expect(ReportAccess.editState(seen, after(60 * MIN))).toBeNull();
	});
	it("keeps a rejected report editable after the window", () => {
		const rejected = {
			...base,
			reviewStatus: "rejected" as const,
			firstSeenAt: seenAt,
			windowStartedAt: seenAt,
		};
		expect(ReportAccess.editState(rejected, after(120 * MIN))).toBeNull();
	});
	it("locks an approved report, even inside the window", () => {
		const approved = {
			...base,
			reviewStatus: "approved" as const,
			firstSeenAt: seenAt,
			windowStartedAt: seenAt,
		};
		expect(ReportAccess.editState(approved, after(MIN))).toBe(
			"REPORT_APPROVED",
		);
	});
});
