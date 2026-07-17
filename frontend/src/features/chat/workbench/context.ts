import type { FsClient, SendResourceReq } from "./fsClient";
import type { PluginMeta } from "./sandbox/api";

// The shared context handed to the file browser and every renderer host. The workbench
// is FILE-centric: one browser; per selected file the user gets pin / preview / raw.
// (The old panel/tab registry is retired — files, not tabs, are the unit of the UI.)
// This stays a *frontend* convention, NOT a backend isolation contract — the backend
// seam is just resource verbs (fs.*) gated by channel-role.
export interface WorkbenchContext {
  channelId: string;
  fs: FsClient;
  /** Raw resource client (any verb). Used to proxy whitelisted channel.* reads to plugins. */
  sendResourceReq: SendResourceReq;
  /** Paths pinned to every bot prompt (the semantic layer — e.g. a prompt template). */
  pinned: string[];
  /** Pin / unpin a file path (persisted in .workbench.json). */
  togglePin: (path: string) => void;
  /** Installed server-level renderer plugins (preview candidate source). */
  plugins: PluginMeta[];
  /** path -> renderer id: the user's explicit Preview renderer for a file (otherwise the
   *  best content-matching candidate is used). Persisted in .workbench.json. */
  bindings: Record<string, string>;
  /** Set (or clear, with null) a file's renderer binding. */
  setBinding: (path: string, rendererId: string | null) => void;
  /** path -> lens config (e.g. table columns). Written create-only by scenario
   *  activation; consumed by built-in lenses at preview time. Persisted in .workbench.json. */
  configs: Record<string, unknown>;
  /** Deep-link target: a file path the browser should auto-open (e.g. a clicked Desk
   *  ref in a bot reply, or a just-activated scenario's first file). */
  openTarget?: string | null;
  /** Navigate the user's view to a `cheers:` locator (desk / ws / inbox — see
   *  features/chat/locator.ts). Handed to renderer plugins as the cheers:open host
   *  API; implemented by ChannelView, which owns every jump surface. UI routing only. */
  openLocator?: (uri: string) => void;
  /** PREFILL the channel composer with a suggested message (the cheers:compose host
   *  API). Never sends — the human reviews and presses send; that keystroke is what
   *  turns a plugin suggestion into a channel action. */
  composeMessage?: (text: string) => void;
  /** Live-push tick for the Desk ("files" board): bump → the browser re-pulls the tree
   *  and reloads a clean open file (unsaved edits are never clobbered). */
  filesTick?: number;
}
