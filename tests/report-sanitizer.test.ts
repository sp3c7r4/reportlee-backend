/** Report HTML sanitiser (design D1, D27, AC21, AC22). Pure, no database. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	htmlToText,
	MAX_RAW_HTML,
	sanitizeReportHtml,
	visibleTextLength,
} from "@/modules/report/report-sanitizer";

const clean = sanitizeReportHtml;
const LINK = 'target="_blank" rel="noopener noreferrer"';

describe("sanitizeReportHtml removes active content", () => {
	it("drops a script element with its contents", () => {
		const out = clean("<p>hi</p><script>alert('x')</script>");
		expect(out).toBe("<p>hi</p>");
		expect(out).not.toContain("alert");
	});
	it("drops style elements with their contents, and style attributes", () => {
		expect(clean('<style>p{color:red}</style><p style="color:red">a</p>')).toBe(
			"<p>a</p>",
		);
	});
	it("strips onerror and onclick, and drops img, svg and iframe but keeps their text", () => {
		const out = clean(
			'<p onclick="x()">a</p><img src=x onerror="alert(1)"><svg onload="x()">t</svg><iframe src="https://example.com">f</iframe>',
		);
		expect(out).not.toMatch(/onerror|onclick|onload|<img|<svg|<iframe/i);
		expect(out).toBe("<p>a</p>tf");
	});
	it("removes class and id attributes", () => {
		expect(clean('<p class="x" id="y">a</p>')).toBe("<p>a</p>");
	});
});

describe("sanitizeReportHtml keeps editor formatting", () => {
	it("keeps bold, italics, underline, strike, code and lists", () => {
		const html =
			"<p><strong>b</strong> <em>i</em> <u>u</u> <s>s</s> <code>c</code></p><ul><li>x</li></ul><ol><li>y</li></ol><blockquote><p>q</p></blockquote><pre><code>z</code></pre><hr />";
		expect(clean(html)).toBe(html.replace("<hr />", "<hr />"));
	});
	it("keeps h1 to h6", () => {
		for (const n of [1, 2, 3, 4, 5, 6]) {
			expect(clean(`<h${n}>t</h${n}>`)).toBe(`<h${n}>t</h${n}>`);
		}
	});
	it("keeps https and mailto links with forced attributes", () => {
		expect(clean('<a href="https://example.com">x</a>')).toBe(
			`<a href="https://example.com" ${LINK}>x</a>`,
		);
		expect(clean('<a href="mailto:a@example.com">m</a>')).toBe(
			`<a href="mailto:a@example.com" ${LINK}>m</a>`,
		);
	});
	it("replaces target and rel the input carried", () => {
		expect(
			clean('<a href="https://example.com" target="_self" rel="opener">x</a>'),
		).toBe(`<a href="https://example.com" ${LINK}>x</a>`);
	});
});

describe("sanitizeReportHtml drops unsafe or non-absolute hrefs", () => {
	for (const href of [
		"javascript:alert(1)",
		" javascript:alert(1)",
		"JaVaScRiPt:alert(1)",
		"&#106;avascript:alert(1)",
		"data:text/html,x",
		"/relative",
		"x/y",
		"#a",
		"//evil.example",
		"vbscript:x",
	]) {
		it(`drops href="${href}"`, () => {
			const out = clean(`<a href="${href}">t</a>`);
			expect(out).not.toContain("href");
			expect(out).toBe(`<a ${LINK}>t</a>`);
		});
	}
});

describe("sanitizeReportHtml properties", () => {
	it("is idempotent", () => {
		const inputs = [
			'<p onclick="x">a <a href="https://example.com" rel="x">l</a></p><script>s</script>',
			"<h5>t</h5><img src=x onerror=y><ul><li>i</li></ul>",
			"plain & <b>bold</b>",
		];
		for (const input of inputs) {
			const once = clean(input);
			expect(clean(once)).toBe(once);
		}
	});
	it("refuses input over the raw limit before parsing", () => {
		expect(MAX_RAW_HTML).toBe(20000);
		expect(() => clean("a".repeat(MAX_RAW_HTML + 1))).toThrow(RangeError);
		expect(() => clean("a".repeat(MAX_RAW_HTML))).not.toThrow();
	});
});

interface TextCase {
	html: string;
	text: string;
	length: number;
}
const cases: TextCase[] = JSON.parse(
	readFileSync(join(__dirname, "fixtures", "report-text.cases.json"), "utf-8"),
);

describe("htmlToText and visibleTextLength (D27, shared cases)", () => {
	it("has cases to run", () => {
		expect(cases.length).toBeGreaterThan(5);
	});
	for (const c of cases) {
		it(`counts ${JSON.stringify(c.html)}`, () => {
			expect(htmlToText(c.html)).toBe(c.text);
			expect(visibleTextLength(c.html)).toBe(c.length);
		});
	}
	it("counts what survives sanitising, not the raw markup", () => {
		expect(visibleTextLength("<p>ok</p><script>secret text</script>")).toBe(2);
	});
});
