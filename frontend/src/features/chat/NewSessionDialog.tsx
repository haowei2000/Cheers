import { Button as UiButton } from "@/components/ui/button";
import { Input as UiInput } from "@/components/ui/input";
import { Textarea as UiTextarea } from "@/components/ui/textarea";
import { DropdownSelect } from "@/components/ui/dropdown-select";
import { useEffect, useState } from "react";
import { notify, messageOf } from "@/lib/notify";
import toast from "react-hot-toast";
import { Bot, Check, Folder, FolderOpen, Plus } from "lucide-react";
import { createChannelBotSession } from "@/api/sessionControl";
import { getWorkspaceMeta, type WorkspaceMeta } from "@/api/workspace";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { bustBotControls } from "./sessionControlsCache";
import { isComposing } from "@/lib/ime";
import { isTauri } from "@/lib/serverConfig";
import { pickFolder } from "@/lib/desktop";
import {
  addRecentWorkspace,
  formatWorkspaceDisplayPath,
  getRecentWorkspaces,
  type RecentWorkspace,
} from "@/lib/recentWorkspaces";

export function NewSessionDialog({
  channelId,
  bots,
  initialBotId,
  initialCwd,
  onClose,
  onCreated,
}: {
  channelId: string;
  /** Bots the caller may create sessions for: id → label. */
  bots: { id: string; label: string }[];
  /** Optional context when starting from an existing session. */
  initialBotId?: string;
  initialCwd?: string;
  onClose: () => void;
  /** Fires with the created session so callers can refetch and/or auto-target it. */
  onCreated: (created: { session_id: string; bot_id: string }) => void;
}) {
  const [botId, setBotId] = useState(initialBotId && bots.some((bot) => bot.id === initialBotId) ? initialBotId : bots[0]?.id ?? "");
  const [cwd, setCwd] = useState(initialCwd ?? "");
  const [dirs, setDirs] = useState("");
  const [busy, setBusy] = useState(false);
  const [recents, setRecents] = useState<RecentWorkspace[]>(() => getRecentWorkspaces());
  const visibleRecents = recents.filter((workspace) => !workspace.botId || workspace.botId === botId);

  useEffect(() => {
    const onRecentChange = () => setRecents(getRecentWorkspaces());
    window.addEventListener("cheers:recent-workspaces-changed", onRecentChange);
    return () => window.removeEventListener("cheers:recent-workspaces-changed", onRecentChange);
  }, []);

  // The connector's workspace policy for the selected bot — turns the blind
  // absolute-path inputs into a pick-from-allowed-roots affordance. Best-effort:
  // null (offline connector / older gateway) keeps the plain inputs.
  const [meta, setMeta] = useState<WorkspaceMeta | null>(null);
  useEffect(() => {
    if (!botId) {
      setMeta(null);
      return;
    }
    let alive = true;
    getWorkspaceMeta(channelId, botId)
      .then((m) => alive && setMeta(m))
      .catch(() => alive && setMeta(null));
    return () => {
      alive = false;
    };
  }, [channelId, botId]);

  async function handlePickFolder() {
    try {
      const picked = await pickFolder();
      if (picked) {
        setCwd(picked);
      }
    } catch (e) {
      notify.error(messageOf(e));
    }
  }

  async function create() {
    if (!botId || busy) return;
    setBusy(true);
    try {
      const trimmedCwd = cwd.trim();
      const additional = dirs
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      const created = await createChannelBotSession(
        channelId,
        botId,
        trimmedCwd || additional.length
          ? { cwd: trimmedCwd || undefined, additional_dirs: additional.length ? additional : undefined }
          : undefined
      );
      toast.success("New session created");
      const finalCwd = trimmedCwd || meta?.default_cwd;
      if (finalCwd) {
        addRecentWorkspace(finalCwd, botId);
      }
      bustBotControls(channelId, botId);
      onCreated({ session_id: created.session_id, bot_id: botId });
      onClose();
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New session" onClose={onClose} maxWidth="max-w-md">
      <div className="space-y-3">
        <div className="space-y-1">
          <span id="new-session-bot-label" className="text-compact font-medium text-content-muted uppercase tracking-label">Bot</span>
          <DropdownSelect
            ariaLabel="Bot"
            ariaLabelledBy="new-session-bot-label"
            leading={<Bot className="h-3.5 w-3.5 shrink-0 text-content-muted" aria-hidden="true" />}
            label={bots.find((b) => b.id === botId)?.label ?? "Select a bot"}
            value={botId}
            options={bots.map((b) => ({ value: b.id, label: b.label }))}
            onSelect={(value) => setBotId(value)}
            controlSize="regular"
            controlWidth="fill"
            disabled={busy}
            className="w-full justify-between rounded-sm bg-control/60 px-3 ring-1 ring-inset ring-zinc-700/60 focus:ring-1 focus:ring-content-strong/50"
            menuClassName="w-full"
          />
        </div>

        {visibleRecents.length > 0 && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-compact font-medium text-content-muted uppercase tracking-label">
              <span>Recent projects on this Bot</span>
              <span className="text-minimal font-normal lowercase text-content-muted">
                {visibleRecents.length} saved
              </span>
            </div>
            <div
              className="flex flex-col gap-1 max-h-36 overflow-y-auto rounded-sm p-1 bg-control/30 ring-1 ring-inset ring-control"
              role="listbox"
              aria-label="Recent projects"
            >
              {visibleRecents.map((w) => {
                const isSelected = cwd === w.path;
                return (
                  <UiButton
                    key={w.path}
                    role="option"
                    aria-selected={isSelected}
                    selected={isSelected}
                    variant="plain"
                    controlSize="compact"
                    controlWidth="fill"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setCwd(w.path);
                    }}
                    className="flex items-center justify-between gap-2 rounded-sm text-left hover:bg-control"
                    title={w.path}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Folder className="w-3.5 h-3.5 text-content-muted shrink-0" />
                      <span className="font-medium text-content-primary truncate">{w.name}</span>
                      <span className="font-code text-minimal text-content-muted truncate hidden sm:inline">
                        {formatWorkspaceDisplayPath(w.path)}
                      </span>
                    </div>
                    {isSelected && (
                      <Check className="w-3.5 h-3.5 text-content-strong shrink-0" />
                    )}
                  </UiButton>
                );
              })}
            </div>
          </div>
        )}

        <Field label="Working directory (optional)">
          <span id="new-session-cwd-label" className="sr-only">Working directory (optional)</span>
          <div className="flex items-center gap-2">
            <UiInput
              id="new-session-cwd"
              aria-labelledby="new-session-cwd-label"
              type="text"
              value={cwd}
              disabled={busy}
              placeholder={meta?.default_cwd ? `Default: ${meta.default_cwd}` : "/abs/workdir"}
              list="ws-allowed-roots"
              onChange={(e) => setCwd(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !isComposing(e) && void create()}
              controlSize="regular"
              className="font-code text-compact flex-1"
            />
            {isTauri() && (
              <UiButton
                action="choose"
                content="iconText"
                variant="secondary"
                controlSize="regular"
                controlWidth="content"
                type="button"
                disabled={busy}
                onClick={() => void handlePickFolder()}
                title="Choose a folder on this Mac; enter a path on the Bot's machine for remote workspaces"
                aria-label="Browse folder on this Mac"
                className="shrink-0"
              >
                <FolderOpen className="w-3.5 h-3.5" />
              </UiButton>
            )}
          </div>
          {/* Datalist = suggestions, not a constraint: any path under an allowed root works. */}
          <datalist id="ws-allowed-roots">
            {meta?.allowed_roots.map((r) => (
              // eslint-disable-next-line jsx-a11y/control-has-associated-label -- Option labels the suggestion shown by the labelled working-directory input.
              <option key={r} value={r} label={r} />
            ))}
          </datalist>
          {meta && meta.allowed_roots.length > 0 && (
            <div className="space-y-1 pt-1 text-minimal text-content-muted">
              <div>
                {meta.backend_may_set_cwd
                  ? "Bot machine · allowed roots:"
                  : "Bot machine · this connector does not let the platform set a working directory. Allowed roots:"}
              </div>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Allowed roots">
                {meta.allowed_roots.map((r) => {
                  const isDefault = meta.default_cwd === r;
                  const isSelected = cwd === r;
                  return (
                    <UiButton
                      key={r}
                      role="option"
                      aria-selected={isSelected}
                      selected={isSelected}
                      variant="secondary"
                      controlSize="compact"
                      controlWidth="content"
                      type="button"
                      disabled={busy || !meta.backend_may_set_cwd}
                      onClick={() => setCwd(r)}
                      className="font-code max-w-full truncate"
                      title={`Click to use ${r}${isDefault ? " (default)" : ""}`}
                    >
                      <span className="truncate">{r}</span>
                      {isDefault && (
                        <span className="text-minimal text-content-muted font-normal shrink-0">
                          (default)
                        </span>
                      )}
                    </UiButton>
                  );
                })}
              </div>
            </div>
          )}
        </Field>

        <Field label="Extra roots (optional)" htmlFor="new-session-extra-roots">
          <UiTextarea
            id="new-session-extra-roots"
            value={dirs}
            disabled={busy}
            rows={2}
            placeholder="/abs/extra-root"
            onChange={(e) => setDirs(e.target.value)}
            controlSize="regular"
            className="font-code text-compact"
          />
          <span className="block text-minimal text-content-muted">One absolute path per line.</span>
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <Button action="cancel" variant="ghost" controlSize="compact" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button action="create" content="iconText" controlSize="compact" loading={busy} disabled={busy || !botId} onClick={() => void create()}>
            <Plus className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
