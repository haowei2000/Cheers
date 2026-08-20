import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { Message } from "@/types";
import type { ChannelProfile } from "@/api/channelProfiles";
import type { FsClient, SendResourceReq } from "@/features/chat/workbench/fsClient";

// ONE registry for every channel-scoped contribution. It replaces three that differed
// only in where their result was mounted — registerChannelHeader, registerWorkbenchPanel
// and registerViewBoard — and whose contributions all filtered on the same `profiles[]`.
// The thing they contribute is the same thing: a named, profile-filtered view over
// channel-scoped data. See docs/arch/PANEL_MODEL.md.
//
// A panel's DATA SOURCE is what actually distinguishes the old surfaces (channel files
// vs. a live projection vs. a bot's machine); `surface` only says where the host mounts
// the result. Keep it that way — a new kind of panel is a new source, not a new registry.

/** Where the host mounts a panel. Not a data-model distinction — see the note above. */
export type PanelSurface =
  /** A board in the channel's work lane (the ViewBoard tab strip). */
  | "lane"
  /** A compact strip in the channel header (ChannelHeaderSlot). */
  | "header"
  /** A strip inside the Workbench body, above its scene/file content. */
  | "inline";

/** What a panel is handed to render.
 *
 * This is the ViewBoard's old context widened with the capabilities the header and
 * Workbench surfaces need — deliberately NOT a union of the three old context types.
 * Capabilities a surface cannot provide are simply absent, so a panel that wants one
 * has to handle its absence rather than the host faking it.
 *
 * `WorkbenchContext` (workbench/context.ts) is NOT this and must not become it: it
 * carries pin/binding/config state that belongs to the fs-source panel's own body
 * (SceneWorkbench, FilePanel, RendererHost), none of which are contributions. */
export interface PanelContext {
  channelId: string;
  /** Capability-filtered workflow metadata; credentials are never included. */
  profile?: ChannelProfile | null;
  /** The channel's typed resource client. Absent on surfaces with no resource
   *  channel of their own (the header, which also renders in ChannelPreview) —
   *  verb-bound panels are lane-only and always get one. */
  sendResourceReq?: SendResourceReq;
  /** False when the panel is kept mounted but hidden (its tab isn't active). Panels
   *  defer tick-driven refetches while hidden and catch up on reveal. */
  visible?: boolean;
  /** The host's selected session scope ("" / null = all sessions). */
  scopeSessionId?: string | null;
  /** Live-push: panel id → monotonic counter. A bump means "your data changed". */
  tick?: Record<string, number>;
  /** Channel workspace files. Absent on surfaces with no fs (header). */
  fs?: FsClient;
  /** Jump the chat to a message (scroll + flash). Optional `requestId` deep-links
   *  into that turn's Agent steps Approval row. */
  onJumpToMessage?: (msgId: string, requestId?: string | null) => void;
  /** Navigate to a `cheers:` locator (desk / ws / inbox — see chat/locator.ts). */
  openLocator?: (uri: string) => void;
  /** PREFILL the composer with a suggested message. Never sends — the human reviews
   *  and presses send; that keystroke is what turns a suggestion into a channel action. */
  composeMessage?: (text: string) => void;
  /** Live pending permission messages in this channel. */
  pendingApprovals?: Message[];
  currentUserId?: string;
}

export interface PanelContribution {
  id: string;
  title: string;
  icon?: LucideIcon;
  surface: PanelSurface;
  /** Channel profiles this panel applies to. Omitted = every channel. A panel that
   *  names profiles is hidden in channels without one, matching what all three old
   *  registries did. */
  profiles?: string[];
  /** "session" makes the host offer its session-scope selector and pass
   *  `scopeSessionId`. Replaces ViewBoardDef.sessionScoped. */
  scope?: "channel" | "session";
  render: (ctx: PanelContext) => ReactNode;
}

const registry: PanelContribution[] = [];

/** Register a panel. Idempotent by id: built-in panels register as an import side
 *  effect, so a module imported twice must not double-register. */
export function registerPanel(panel: PanelContribution): void {
  if (registry.some((existing) => existing.id === panel.id)) return;
  registry.push(panel);
}

/** Panels mounted on `surface` in a channel with this profile, in registration order.
 *  A panel with no `profiles` is always included; one that names them needs a match,
 *  so an unprofiled channel sees only unprofiled panels. */
export function panelsFor(surface: PanelSurface, profile?: string | null): PanelContribution[] {
  return registry.filter(
    (panel) =>
      panel.surface === surface &&
      (!panel.profiles || (profile ? panel.profiles.includes(profile) : false))
  );
}

/** Test seam: drop every registration. Never call from product code — panels register
 *  on import, and a cleared registry cannot be repopulated without re-importing them. */
export function resetPanelsForTest(): void {
  registry.length = 0;
}
