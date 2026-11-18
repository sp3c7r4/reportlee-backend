import sanitizeHtml from "sanitize-html";

/** @info - Raw HTML per section is refused above this before parsing (design, draftBody). */
export const MAX_RAW_HTML = 20000;
/** @info - SECTION_MAX and ACCOMPLISHMENTS_MIN in the frontend's src/lib/report-draft.ts. */
export const SECTION_MAX = 5000;
export const ACCOMPLISHMENTS_MIN = 50;

const SAFE_HREF = /^(https?:|mailto:)/i;

/**
 * @info - Allow-list sanitiser for report sections (D1). The transform sees the raw `href` before
 * sanitize-html filters attributes and schemes, so it keeps only absolute http, https and mailto
 * links (no leading whitespace, no relative or protocol-relative value), and the scheme filter is
 * a second layer. Tiptap StarterKit, Link and Underline emit nothing outside this list.
 */
const OPTIONS: sanitizeHtml.IOptions = {
	allowedTags: [
		"p",
		"br",
		"strong",
		"b",
		"em",
		"i",
		"u",
		"s",
		"code",
		"pre",
		"blockquote",
		"ul",
		"ol",
		"li",
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"hr",
		"a",
	],
	allowedAttributes: { a: ["href", "target", "rel"] },
	allowedSchemes: ["http", "https", "mailto"],
	allowedSchemesAppliedToAttributes: ["href"],
	allowProtocolRelative: false,
	disallowedTagsMode: "discard",
	nonTextTags: ["script", "style", "textarea", "option"],
	transformTags: {
		a: (tagName, attribs) => {
			const href = attribs.href;
			return {
				tagName,
				attribs: {
					...(href !== undefined && SAFE_HREF.test(href) && { href }),
					target: "_blank",
					rel: "noopener noreferrer",
				},
			};
		},
	},
};

/** @info - Throws RangeError over MAX_RAW_HTML; the service maps it to a 400 on the field. */
export const sanitizeReportHtml = (html: string): string => {
	if (html.length > MAX_RAW_HTML) {
		throw new RangeError("report section is too long");
	}
	return sanitizeHtml(html, OPTIONS);
};

/** @info - Line for line port of `htmlToText` in the frontend's src/lib/report-draft.ts (D27). Keep them equal. */
export const htmlToText = (html: string): string =>
	html
		.replace(/<(br|\/p|\/li|\/h[1-6])\s*\/?>/gi, " ")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();

/** @info - D27: the length rules read the text a reviewer reads, after sanitising, in UTF-16 code units. */
export const visibleTextLength = (html: string): number =>
	htmlToText(sanitizeReportHtml(html)).length;
