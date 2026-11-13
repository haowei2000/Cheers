import type { Message } from "@/types";
import { quoteSelectedText } from "@/components/ui/context-actions";

/** The selected excerpt belongs to the reply, separately from the editable body. */
export interface ReplyTarget {
  message: Message;
  quote?: string;
}

/** Keep the existing wire format; only serialize the excerpt when sending. */
export function contentWithReplyQuote(content: string, quote?: string): string {
  const excerpt = quote?.replace(/\r\n?/g, "\n").trim();
  return excerpt ? `${quoteSelectedText(excerpt)}\n\n${content}` : content;
}
