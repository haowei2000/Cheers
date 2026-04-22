import type { Message, QaPair } from "../types";
import { parseGuidePayload } from "./guide";
import { isClarifyReplyUserMessage } from "./guide";
import { stripThinkTags } from "./think";
import { formatTs } from "./message";

/** 将消息按逻辑问答块分组（含 clarify 轮次），每个块以用户问题开头 */
export function buildLogicalQaBlocks(
  messages: Message[],
): { question: Message; messages: Message[] }[] {
  const blocks: { question: Message; messages: Message[] }[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.sender_type !== "user" || isClarifyReplyUserMessage(m.content)) {
      i++;
      continue;
    }
    const blockMessages: Message[] = [m];
    let j = i + 1;
    while (j < messages.length) {
      const next = messages[j];
      if (
        next.sender_type === "user" &&
        !isClarifyReplyUserMessage(next.content)
      ) {
        break;
      }
      blockMessages.push(next);
      j++;
    }
    blocks.push({ question: m, messages: blockMessages });
    i = j;
  }
  return blocks;
}

export function buildQaMarkdown(channelName: string, pairs: QaPair[]): string {
  const now = new Date();
  const rows: string[] = [];
  rows.push(`# 问答导出 - ${channelName}`);
  rows.push("");
  rows.push(`导出时间: ${now.toISOString()}`);
  rows.push(`问答数量: ${pairs.length}`);
  rows.push("");
  pairs.forEach((p, idx) => {
    const qText = stripThinkTags(
      parseGuidePayload(p.question.content).text || p.question.content,
    );
    const aText = stripThinkTags(
      parseGuidePayload(p.answer.content).text || p.answer.content,
    );
    rows.push(`## ${idx + 1}. 问答`);
    rows.push("");
    rows.push(`### 问题 (${formatTs(p.question.created_at) || "-"})`);
    rows.push("");
    rows.push(qText || "-");
    rows.push("");
    rows.push(`### 回答 (${formatTs(p.answer.created_at) || "-"})`);
    rows.push("");
    rows.push(aText || "-");
    rows.push("");
    rows.push("---");
    rows.push("");
  });
  return rows.join("\n");
}

export function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
