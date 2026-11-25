/** @file Helpers for inserting mention tokens into composer drafts. */

import type { MentionCandidate } from "./MessageComposer";

/** Escape user-visible mention labels before placing them in a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionPattern(label: string): RegExp {
  return new RegExp(`(^|\\s)@${escapeRegExp(label.trim())}(?=$|\\s|[.,!?;:])`, "g");
}

export function hasMentionToken(text: string, label: string): boolean {
  return Boolean(label.trim()) && mentionPattern(label).test(text);
}

/** Prefer the longest picked label so @Ada Bot never also addresses @Ada. */
export function pickedMentionsInText(text: string, picked: readonly MentionCandidate[]): MentionCandidate[] {
  let remaining = text;
  const found = new Set<string>();
  const matchedLabels = new Set<string>();
  for (const candidate of [...picked].sort((a, b) => b.label.length - a.label.length)) {
    const label = candidate.label.trim();
    if (!matchedLabels.has(label) && !hasMentionToken(remaining, label)) continue;
    found.add(candidate.id);
    matchedLabels.add(label);
    remaining = remaining.replace(mentionPattern(label), "$1");
  }
  return picked.filter((candidate, index) => found.has(candidate.id) && picked.findIndex(item => item.id === candidate.id) === index);
}

/** Recipient tokens alone are an address, not a message body. */
export function hasComposerBody(text: string, labels: string[]): boolean {
  const withoutMentions = [...labels].sort((a, b) => b.length - a.length)
    .reduce((body, label) => body.replace(mentionPattern(label), "$1"), text);
  return withoutMentions.trim().length > 0;
}

/** Continue with individual recipients that still exist in the current channel roster. */
export function createMentionContinuation(
  sent: readonly MentionCandidate[],
  mentionables: readonly MentionCandidate[],
  fixedSession = false,
): { text: string; picked: MentionCandidate[] } {
  const picked = fixedSession ? [] : sent
    .filter(p => p.type !== "group")
    .flatMap(p => mentionables.find(candidate => candidate.id === p.id && candidate.type !== "group") ?? [])
    .filter((p, index, all) => all.findIndex(candidate => candidate.id === p.id) === index);
  return { text: picked.reduce((body, p) => appendMentionToken(body, p.label), ""), picked };
}

/**
 * Add a picked mention at the end of a draft without disturbing typed text.
 * Existing standalone tokens are kept once, while prefix matches such as
 * `@Ann` inside `@Anna` do not suppress the requested mention.
 */
export function appendMentionToken(text: string, label: string): string {
  const token = `@${label.trim()}`;
  if (token === "@") return text;

  if (hasMentionToken(text, label)) return text;

  const separator = text.length > 0 && !/\s$/.test(text) ? " " : "";
  return `${text}${separator}${token} `;
}
