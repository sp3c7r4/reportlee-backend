import sanitizeHtml from "sanitize-html";

const DECODE: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
};

/**
 * @info - D13. Comments, decision reasons, task titles and completion notes are plain text.
 * `sanitize-html` with no allowed tags drops every tag and the content of script and style, but it
 * returns escaped text (`Q&A` becomes `Q&amp;A`). The five entities it emits are decoded back in
 * one pass (so `&amp;lt;` becomes `&lt;`, not `<`), and the result is trimmed. The stored text is
 * what the reader should see: React renders it as text and the email template escapes it once.
 */
export const plainText = (input: string): string => {
	const stripped = sanitizeHtml(input, {
		allowedTags: [],
		allowedAttributes: {},
		textFilter: (text) => text,
	});
	return stripped
		.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => DECODE[entity] ?? entity)
		.trim();
};
