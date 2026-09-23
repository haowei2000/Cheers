import type { FileInfo } from "@/types";
import type { MentionCandidate } from "./MessageComposer";
import type { ContextItem } from "./context/contextPick";

export interface SuggestionBinding { key: string; insertedText: string; context?: ContextItem; mention?: MentionCandidate }

export interface ComposerDraft {
  text: string;
  attachments: FileInfo[];
  picked: MentionCandidate[];
  transcribedIds: Set<string>;
  suggestionBindings?: SuggestionBinding[];
}

const draftsByChannel = new Map<string, ComposerDraft>();
const draftKey = (channelId: string) => `cheers.draft.${channelId}`;

export function clearComposerDrafts(): void {
  draftsByChannel.clear();
}

export function getComposerDraft(channelId?: string): ComposerDraft | undefined {
  return channelId ? draftsByChannel.get(channelId) : undefined;
}

export function stashComposerDraft(channelId: string, draft: ComposerDraft): void {
  if (draft.text || draft.attachments.length) draftsByChannel.set(channelId, draft);
  else draftsByChannel.delete(channelId);
}

export function restoreComposerText(channelId?: string): string {
  if (!channelId) return "";
  const memoryDraft = draftsByChannel.get(channelId);
  if (memoryDraft) return memoryDraft.text;
  try {
    return sessionStorage.getItem(draftKey(channelId)) ?? "";
  } catch {
    return "";
  }
}

export function persistComposerText(channelId: string, text: string): void {
  try {
    if (text) sessionStorage.setItem(draftKey(channelId), text);
    else sessionStorage.removeItem(draftKey(channelId));
  } catch {
    // The in-memory draft still covers channel switches in restricted contexts.
  }
}

const bindingKey = (channelId: string) => `cheers.draft.suggestionBindings.${channelId}`;

export function restoreSuggestionBindings(channelId?: string): SuggestionBinding[] {
  if (!channelId) return [];
  const memory = draftsByChannel.get(channelId)?.suggestionBindings;
  if (memory) return memory;
  try {
    const raw = JSON.parse(sessionStorage.getItem(bindingKey(channelId)) ?? "[]");
    return Array.isArray(raw) ? raw.filter((b) => b && typeof b.key === "string" && typeof b.insertedText === "string") : [];
  } catch { return []; }
}

export function persistSuggestionBindings(channelId: string, bindings: SuggestionBinding[]): void {
  try {
    if (bindings.length) sessionStorage.setItem(bindingKey(channelId), JSON.stringify(bindings));
    else sessionStorage.removeItem(bindingKey(channelId));
  } catch { /* Draft still survives channel switches in memory. */ }
}
