import { useMemo } from "react";
import { create } from "zustand";

// Resource-context pickup (docs/design/RESOURCE_CONTEXT.md, F1). A participant
// attaches Cheers resources (plan / file / message / activity) to a message as
// structured context. Two entry points — the composer "add context" menu and
// in-panel "attach" affordances (Viewboard / Workbench) — both push items here;
// the composer reads them, renders chips, and includes them on send.

/** One resource reference in a context bundle. `verb`/`params` name an existing
 *  resource-protocol read; the receiving agent resolves it as itself. */
export interface ContextItem {
  /** Stable id for de-dup + chip keys (e.g. `plan:<sid>`, `file:<id>`). */
  id: string;
  /** Resource verb the agent resolves (`channel.plan.read`, `channel.files.read`, …). */
  verb: string;
  /** Params for the verb (channel_id is injected at send time if absent). */
  params: Record<string, unknown>;
  /** Human label shown on the chip. */
  label: string;
  /** Category — drives the chip icon. */
  kind: "plan" | "file" | "message" | "activity" | "sessions" | "cost";
}

/** The wire shape persisted on the message / delivered to the task frame. */
export interface ContextBundle {
  origin: "human" | "handoff";
  items: Array<{
    verb: string;
    params: Record<string, unknown>;
    label: string;
    kind: string;
  }>;
}

interface ContextPickState {
  /** Pending items per channel (the composer draft's attached context). */
  byChannel: Record<string, ContextItem[]>;
  /** Suggestions the user dismissed this session, keyed `${channelId}:${itemId}`,
   *  so a declined suggestion doesn't nag again until reload (F3). */
  dismissed: Record<string, true>;
  add: (channelId: string, item: ContextItem) => void;
  remove: (channelId: string, itemId: string) => void;
  clear: (channelId: string) => void;
  dismissSuggestion: (channelId: string, itemId: string) => void;
}

export const useContextPickStore = create<ContextPickState>((set) => ({
  byChannel: {},
  dismissed: {},
  add: (channelId, item) =>
    set((s) => {
      const cur = s.byChannel[channelId] ?? [];
      if (cur.some((i) => i.id === item.id)) return s; // de-dup by id
      return { byChannel: { ...s.byChannel, [channelId]: [...cur, item] } };
    }),
  remove: (channelId, itemId) =>
    set((s) => ({
      byChannel: {
        ...s.byChannel,
        [channelId]: (s.byChannel[channelId] ?? []).filter((i) => i.id !== itemId),
      },
    })),
  clear: (channelId) =>
    set((s) => {
      if (!s.byChannel[channelId]?.length) return s;
      const next = { ...s.byChannel };
      delete next[channelId];
      return { byChannel: next };
    }),
  dismissSuggestion: (channelId, itemId) =>
    set((s) => ({ dismissed: { ...s.dismissed, [`${channelId}:${itemId}`]: true } })),
}));

// Stable empty reference so the selector doesn't return a fresh [] each render
// (which trips zustand's getSnapshot cache → infinite re-render loop).
const EMPTY: ContextItem[] = [];

/** Read the pending items for a channel (selector-friendly). */
export function usePendingContext(channelId: string | undefined): ContextItem[] {
  return useContextPickStore((s) =>
    channelId ? s.byChannel[channelId] ?? EMPTY : EMPTY
  );
}

// Stable empty reference for the dismissed map, same rationale as EMPTY above.
const EMPTY_DISMISSED: Record<string, true> = {};

/** The minimal shape of the message the composer is replying to (F3 signal). */
export interface ReplyTargetLike {
  msg_id: string;
  channel_seq?: number;
  sender_name?: string;
}

/** A context ref for a single channel message, addressed by its seq — the wire
 *  verb is `channel.messages.by-seq` with a one-message [seq, seq] window. */
export function messageContextItem(msg: ReplyTargetLike): ContextItem | undefined {
  if (msg.channel_seq == null) return undefined; // can't address it without a seq
  const who = msg.sender_name?.trim();
  return {
    id: `msg:${msg.channel_seq}`,
    verb: "channel.messages.by-seq",
    params: { min_seq: msg.channel_seq, max_seq: msg.channel_seq },
    label: who ? `Reply to ${who}` : `Message #${msg.channel_seq}`,
    kind: "message",
  };
}

/** Suggested context for the current draft (docs/design/RESOURCE_CONTEXT.md, F3 —
 *  human, automatic pick). Surfaces one-click chips from signals the composer
 *  already has; today: the reply target. Per the hard rule these are only
 *  *suggestions* — visible + one-click to add, one-click to dismiss, NEVER
 *  auto-committed. Filters out anything already picked or dismissed this session. */
export function useContextSuggestions(
  channelId: string | undefined,
  replyTo: ReplyTargetLike | null | undefined
): ContextItem[] {
  const picked = usePendingContext(channelId);
  const dismissed = useContextPickStore((s) =>
    channelId ? s.dismissed : EMPTY_DISMISSED
  );
  const replySeq = replyTo?.channel_seq;
  const replyName = replyTo?.sender_name;
  return useMemo(() => {
    if (!channelId) return EMPTY;
    const out: ContextItem[] = [];
    const suggestion = replyTo ? messageContextItem(replyTo) : undefined;
    if (
      suggestion &&
      !picked.some((i) => i.id === suggestion.id) &&
      !dismissed[`${channelId}:${suggestion.id}`]
    ) {
      out.push(suggestion);
    }
    return out.length ? out : EMPTY;
    // replyTo is captured via its stable fields so the memo doesn't rerun on
    // unrelated re-renders that hand a fresh object with the same message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, replySeq, replyName, picked, dismissed]);
}

/** Build the wire bundle from picked items, injecting channel_id into params. */
export function toBundle(
  items: ContextItem[],
  channelId: string
): ContextBundle | undefined {
  if (!items.length) return undefined;
  return {
    origin: "human",
    items: items.map((it) => ({
      verb: it.verb,
      params: { channel_id: channelId, ...it.params },
      label: it.label,
      kind: it.kind,
    })),
  };
}
