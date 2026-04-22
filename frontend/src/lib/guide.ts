import type { GuideFormSchema, ClarifySchema } from "../types";

export const GUIDE_FORM_BLOCK = /```guide-form\n([\s\S]*?)```/;
export const GUIDE_CLARIFY_BLOCK = /```guide-clarify\n([\s\S]*?)```/;

export function parseGuidePayload(content: string): {
  text: string;
  form?: GuideFormSchema;
  clarify?: ClarifySchema;
} {
  let text = content;
  let form: GuideFormSchema | undefined;
  let clarify: ClarifySchema | undefined;

  const formMatch = text.match(GUIDE_FORM_BLOCK);
  if (formMatch) {
    try {
      form = JSON.parse(formMatch[1].trim()) as GuideFormSchema;
      text = text.replace(formMatch[0], "");
    } catch {}
  }

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

  return { text: text.trim(), form, clarify };
}

export function isClarifyReplyUserMessage(content: string): boolean {
  const t = (content || "").trim();
  return (
    t.startsWith("@channel bot 澄清回答：") || t.includes("用户选择跳过澄清")
  );
}
