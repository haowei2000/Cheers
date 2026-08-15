import type { FsClient, SendResourceReq } from "./fsClient";
import type { RendererExtension } from "./sandbox/rendererExtension";

// The shared context handed to scene navigation, the Raw file browser, and renderer
// hosts. Paths remain the storage contract; scene items are the default navigation.
// This stays a *frontend* convention, NOT a backend isolation contract — the backend
// seam is just resource verbs (fs.*) gated by channel-role.
export interface WorkbenchContext {
  /** False while the drawer is closed so code renderers can dispose instead of running hidden. */
  active: boolean;
  channelId: string;
  fs: FsClient;
  /** Raw resource client used to proxy manifest-whitelisted channel reads. */
  sendResourceReq: SendResourceReq;
  /** Paths pinned to every bot prompt (the semantic layer — e.g. a prompt template). */
  pinned: string[];
  /** Pin / unpin a file path (persisted in .workbench.json). */
  togglePin: (path: string) => void;
  /** Personal or temporary macOS renderer extensions. */
  rendererExtensions: RendererExtension[];
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
   *  features/chat/locator.ts). Exposed to renderers only with permission.
   *  API; implemented by ChannelView, which owns every jump surface. UI routing only. */
  openLocator?: (uri: string) => void;
  /** PREFILL the channel composer with a suggested message (the composer.prefill host
   *  API). Never sends — the human reviews and presses send; that keystroke is what
   *  turns an extension suggestion into a channel action. */
  composeMessage?: (text: string) => void;
  /** Live-push tick for the Desk ("files" board): bump → the browser re-pulls the tree
   *  and reloads a clean open file (unsaved edits are never clobbered). */
  filesTick?: number;
}
