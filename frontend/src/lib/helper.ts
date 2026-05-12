import type { ClarifySchema } from "../types";

export const HELPER_CLARIFY_BLOCK = /```helper-clarify\n([\s\S]*?)```/;
/** Legacy "动态表单" block; the feature is removed but we still strip the
 * fenced JSON if any old message in history happens to carry one, so the
 * raw payload doesn't leak into the rendered text. */
const HELPER_FORM_BLOCK_LEGACY = /```helper-form\n[\s\S]*?```/;

export function parseHelperPayload(content: string): {
  text: string;
  clarify?: ClarifySchema;
} {
  let text = content;
  let clarify: ClarifySchema | undefined;

  // Strip any legacy helper-form JSON block from the rendered text.
  text = text.replace(HELPER_FORM_BLOCK_LEGACY, "");

  const clarifyMatch = text.match(HELPER_CLARIFY_BLOCK);
  if (clarifyMatch) {
    try {
      const parsed = JSON.parse(clarifyMatch[1].trim()) as ClarifySchema;
      if (Array.isArray(parsed?.questions) && parsed.questions.length > 0) {
        clarify = parsed;
      }
      text = text.replace(clarifyMatch[0], "");
    } catch {}
  }

  return { text: text.trim(), clarify };
}

export function isClarifyReplyUserMessage(content: string): boolean {
  const t = (content || "").trim();
  return (
    t.startsWith("@Helper 澄清回答：") ||
    t.startsWith("@Coordinator 澄清回答：") ||
    t.startsWith("@channel bot 澄清回答：") || // 历史名兜底
    t.includes("用户选择跳过澄清")
  );
}
