import type { ClarifySchema } from "../types";

export const GUIDE_CLARIFY_BLOCK = /```guide-clarify\n([\s\S]*?)```/;
/** Legacy "动态表单" block; the feature is removed but we still strip the
 * fenced JSON if any old message in history happens to carry one, so the
 * raw payload doesn't leak into the rendered text. */
const GUIDE_FORM_BLOCK_LEGACY = /```guide-form\n[\s\S]*?```/;

export function parseGuidePayload(content: string): {
  text: string;
  clarify?: ClarifySchema;
} {
  let text = content;
  let clarify: ClarifySchema | undefined;

  // Strip any legacy guide-form JSON block from the rendered text.
  text = text.replace(GUIDE_FORM_BLOCK_LEGACY, "");

  const clarifyMatch = text.match(GUIDE_CLARIFY_BLOCK);
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
    t.startsWith("@Coordinator 澄清回答：") ||
    t.startsWith("@channel bot 澄清回答：") || // 历史名兜底
    t.includes("用户选择跳过澄清")
  );
}
