import { createContext } from "react";
import type { FileInfo } from "@/types";

/**
 * Open a clicked file reference, already bound by the provider to the message's
 * sender bot. The token is a filename/path the user clicked; resolution to the
 * right store happens downstream. Null on non-bot messages. Consumed by MarkdownRenderer.
 */
export const PathOpenContext = createContext<((ref: string) => void) | null>(null);

/** A clicked file reference + the context needed to resolve it by provenance. */
export interface RefClick {
  senderBotId: string;
  ref: string;
  files?: FileInfo[];
}

/** Resolve+open a clicked file reference. Provided by ChannelView. */
export const ResolveRefContext = createContext<((c: RefClick) => void) | null>(null);

/** Heuristic: does a backtick-wrapped inline-code token look like a workspace file path? */
export function looksLikePath(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 200 || /\s/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false; // URL / scheme
  const hasSlash = t.includes("/");
  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(t);
  return hasSlash || hasExt;
}
