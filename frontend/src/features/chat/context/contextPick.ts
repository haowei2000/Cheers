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
  add: (channelId: string, item: ContextItem) => void;
  remove: (channelId: string, itemId: string) => void;
  clear: (channelId: string) => void;
}

export const useContextPickStore = create<ContextPickState>((set) => ({
  byChannel: {},
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
