import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/api/client";
import { makeFsClient } from "@/features/chat/workbench/fsClient";
import type { PanelContext } from "./registry";

// WHERE a panel's data comes from. This is the distinction that actually separated the
// old Workbench / ViewBoard / Remote workspace subsystems — channel files vs. a live
// projection of platform state vs. a bot's machine — recorded here as one axis of the
// panel model instead of three parallel hosts. See docs/arch/PANEL_MODEL.md.
//
// The kinds are NOT interchangeable at the authorization layer and must never be made
// so: `fs` verbs authorize by channel-role, while `workspace` authorizes per-bot against
// the session-workdir root-set. Unifying how a panel ASKS for data does not unify who is
// allowed to answer.

export type PanelSource =
  /** A live, read-only projection read from a resource verb (`*.read`). */
  | {
      kind: "resource";
      verb: string;
      params?: (ctx: PanelContext) => Record<string, unknown>;
      /** Key to unwrap from the response before the view sees it. Every `channel.*` verb
       *  wraps its payload (`{"members": [...], "total": N}`) while the array views want
       *  the bare list. A missing key yields undefined, which views already render as
       *  empty — this must not throw. */
      pick?: string;
    }
  /** A file in the channel workspace (`context_files`), read through `fs.*`. */
  | { kind: "fs"; path: string }
  /** A gateway REST endpoint, for state with no resource verb (the approval audit). */
  | { kind: "rest"; endpoint: (ctx: PanelContext) => string }
  /** A path on a bot's own machine. See PLUGGABLE_SOURCE_KINDS. */
  | { kind: "workspace"; botId: string; path: string };

export type PanelSourceKind = PanelSource["kind"];

/** Source kinds a third-party package may declare.
 *
 * `workspace` is excluded because a manifest is attacker-controlled data and that kind
 * names paths on someone's actual machine under an authorization model the channel-role
 * check does not cover. `rest` is excluded because an arbitrary endpoint is not a
 * vocabulary — the resource verbs are, and they are already allowlisted
 * (EXTENSION_CHANNEL_RESOURCES). Both stay first-party.
 *
 * The manifest validators enforce this on both sides; this constant is the single
 * declaration they agree on. */
export const PLUGGABLE_SOURCE_KINDS: readonly PanelSourceKind[] = ["resource", "fs"];

export function isPluggableSource(kind: string): kind is PanelSourceKind {
  return (PLUGGABLE_SOURCE_KINDS as readonly string[]).includes(kind);
}

/** Which live-push channel tells this source its data changed.
 *
 * Three signals existed independently — `board_signal` per board, the shared `files`
 * tick, and the bot-scoped `workspace_signal` — and each panel wired its own. They are
 * one question ("did my source change?") answered from different places. */
export function tickKeyFor(source: PanelSource, panelId: string): string {
  switch (source.kind) {
    case "fs":
      return "files"; // one shared tick for the whole channel workspace
    case "workspace":
      return "workspace";
    default:
      return panelId; // resource / rest panels each get their own board_signal
  }
}

/** Build the one-shot fetch for a source, or null when this context cannot serve it.
 *  Exported as the routing seam: it is a pure function of (source, ctx), so which
 *  client a source reaches can be asserted without rendering anything. */
export function fetcherFor(
  source: PanelSource,
  ctx: PanelContext
): (() => Promise<unknown>) | null {
  switch (source.kind) {
    case "resource": {
      const send = ctx.sendResourceReq;
      if (!send) return null;
      const params = source.params?.(ctx) ?? { channel_id: ctx.channelId };
      const pick = source.pick;
      return () =>
        send(source.verb, params).then((value) =>
          pick ? (value as Record<string, unknown> | null)?.[pick] : value
        );
    }
    case "fs": {
      const send = ctx.sendResourceReq;
      if (!send) return null;
      const fs = ctx.fs ?? makeFsClient(send, ctx.channelId);
      return () => fs.read(source.path);
    }
    case "rest":
      return () => apiJson<unknown>(source.endpoint(ctx));
    case "workspace":
      // Deliberately unserved. A bot's machine is reached through the bot-scoped
      // /workspace/* REST client under a different authorization model, and
      // RemoteWorkspaceDialog still owns that plane directly. The kind exists so the
      // model names every source honestly and so the manifest validators have
      // something to reject — not as a half-built second path to a real filesystem.
      return null;
  }
}

export interface PanelDataState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Load a panel's data from its source. One loader for every kind, so a panel declares
 *  where its data lives and nothing else. Holds off (rather than erroring) until the
 *  context can serve the source — e.g. before a channel is selected. */
export function usePanelData<T = unknown>(
  source: PanelSource,
  ctx: PanelContext,
  enabled = true
): PanelDataState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetcher = fetcherFor(source, ctx);
  const unservable = fetcher === null;
  // Serialize the request so the effect re-runs on a real change, not on each render's
  // new closure identity.
  const key = JSON.stringify([
    source.kind,
    ctx.channelId,
    source.kind === "resource" ? [source.verb, source.pick ?? null, source.params?.(ctx) ?? null] : null,
    source.kind === "fs" ? source.path : null,
    source.kind === "rest" ? source.endpoint(ctx) : null,
    source.kind === "workspace" ? [source.botId, source.path] : null,
  ]);

  const run = useCallback(() => {
    if (!enabled || !ctx.channelId) return;
    if (!fetcher) {
      setError(`This surface cannot read a "${source.kind}" source`);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcher()
      .then((value) => {
        if (!cancelled) setData(value as T);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `key` stands in for the fetcher's identity; `fetcher` itself is a new closure
    // every render and would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ctx.channelId, key, unservable]);

  useEffect(() => run(), [run]);

  return { data, loading, error, refetch: run };
}
