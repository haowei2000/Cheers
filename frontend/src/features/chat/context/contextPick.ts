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

/** A context ref for a channel file (the Workbench/inbox `channel.files.read`). */
export function fileContextItem(file: FileRef): ContextItem {
  return {
    id: `file:${file.file_id}`,
    verb: "channel.files.read",
    params: { file_id: file.file_id },
    label: file.filename,
    kind: "file",
  };
}

/** A context ref for a line range of a Workbench (desk) file — a picked passage.
 *  The `fs.read` verb takes `start_line`/`end_line` (1-indexed inclusive); the
 *  agent resolves just that slice on demand. */
export function rangedFileContextItem(
  path: string,
  startLine: number,
  endLine: number
): ContextItem {
  const base = path.split("/").pop() || path;
  return {
    id: `file:${path}:${startLine}-${endLine}`,
    verb: "fs.read",
    params: { path, start_line: startLine, end_line: endLine },
    label: `${base}:${startLine}-${endLine}`,
    kind: "file",
  };
}

/** Map a selected substring to its 1-indexed inclusive line range within
 *  `content`. Returns `null` when the selection is empty or not found (e.g. a
 *  selection spanning virtualized/off-screen lines the DOM didn't hand back). */
export function selectionLineRange(
  content: string,
  selected: string
): { start: number; end: number } | null {
  const text = selected.replace(/\r\n/g, "\n");
  if (!text.trim()) return null;
  const idx = content.indexOf(text);
  if (idx < 0) return null;
  const start = content.slice(0, idx).split("\n").length; // 1-indexed
  const end = start + text.split("\n").length - 1;
  return { start, end };
}

/** A channel file the draft might reference (built from loaded messages). */
export interface FileRef {
  file_id: string;
  filename: string;
}

/** Signals the composer can hand the suggester (all optional). */
export interface SuggestionSignals {
  /** The message being replied to → suggest it as context. */
  replyTo?: ReplyTargetLike | null;
  /** The live draft text → filename / "plan" keyword detection. */
  draftText?: string;
  /** Channel files (id + name) to match filenames against. */
  files?: FileRef[];
}

// Shortest filename we'll match in free text — avoids noise from 1-3 char names.
const MIN_FILENAME_MATCH = 4;
// Cap suggestions so the bar never floods.
const MAX_SUGGESTIONS = 4;
const EMPTY_FILES: FileRef[] = [];

/** Pure core of the suggester (unit-tested). Produces the ordered, de-duplicated,
 *  picked/dismissed-filtered, capped suggestion list from the raw signals. */
export function computeSuggestions(
  channelId: string | undefined,
  signals: SuggestionSignals,
  picked: ContextItem[],
  dismissed: Record<string, true>
): ContextItem[] {
  if (!channelId) return [];
  const { replyTo, draftText = "", files = EMPTY_FILES } = signals;
  const candidates: ContextItem[] = [];

  // 1) Reply target.
  if (replyTo) {
    const it = messageContextItem(replyTo);
    if (it) candidates.push(it);
  }

  const lower = draftText.toLowerCase();
  if (lower.trim()) {
    // 2) Filenames named in the draft (match loaded channel files by basename).
    for (const f of files) {
      const name = (f.filename || "").trim();
      if (name.length >= MIN_FILENAME_MATCH && lower.includes(name.toLowerCase())) {
        candidates.push(fileContextItem(f));
      }
    }
    // 3) The plan, when the draft talks about "the plan".
    if (/\bplan\b/.test(lower)) {
      candidates.push({
        id: "plan",
        verb: "channel.plan.read",
        params: {},
        label: "Plan",
        kind: "plan",
      });
    }
  }

  // De-dup by id, drop already-picked / dismissed, cap.
  const seen = new Set<string>();
  const out: ContextItem[] = [];
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    if (picked.some((i) => i.id === c.id)) continue;
    if (dismissed[`${channelId}:${c.id}`]) continue;
    out.push(c);
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

/** Suggested context for the current draft (docs/design/RESOURCE_CONTEXT.md, F3 —
 *  human, automatic pick). Surfaces one-click chips from signals the composer
 *  already has: the reply target, a filename named in the draft, and the plan
 *  when the draft talks about it. Per the hard rule these are only *suggestions*
 *  — visible, one-click to add, one-click to dismiss, NEVER auto-committed.
 *  Filters out anything already picked or dismissed this session. */
export function useContextSuggestions(
  channelId: string | undefined,
  signals: SuggestionSignals
): ContextItem[] {
  const picked = usePendingContext(channelId);
  const dismissed = useContextPickStore((s) =>
    channelId ? s.dismissed : EMPTY_DISMISSED
  );
  const { replyTo, draftText = "", files = EMPTY_FILES } = signals;
  const replySeq = replyTo?.channel_seq;
  const replyName = replyTo?.sender_name;
  return useMemo(() => {
    const out = computeSuggestions(channelId, { replyTo, draftText, files }, picked, dismissed);
    return out.length ? out : EMPTY;
    // replyTo captured via its stable fields; `files` is a memoized ref from the
    // caller so identical file sets don't rerun this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, replySeq, replyName, draftText, files, picked, dismissed]);
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
