function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Add a picked mention at the end of a draft without disturbing typed text.
 * Existing standalone tokens are kept once, while prefix matches such as
 * `@Ann` inside `@Anna` do not suppress the requested mention.
 */
export function appendMentionToken(text: string, label: string): string {
  const token = `@${label.trim()}`;
  if (token === "@") return text;

  const existing = new RegExp(
    `(^|\\s)${escapeRegExp(token)}(?=$|\\s|[.,!?;:])`,
  );
  if (existing.test(text)) return text;

  const separator = text.length > 0 && !/\s$/.test(text) ? " " : "";
  return `${text}${separator}${token} `;
}
