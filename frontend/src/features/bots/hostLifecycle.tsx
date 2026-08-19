import { useState, type ReactNode } from "react";
import { Ban, KeyRound, Power, RefreshCw, Trash2 } from "lucide-react";

import {
  activateConnectorHost,
  deleteHostRecord,
  reconnectConnectorHost,
  revokeConnectorHost,
  rotateTerminalCredential,
} from "@/api/bots";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { messageOf, notify } from "@/lib/notify";

/** The fields every host surface has in common. `FleetHost`
 *  satisfies this as-is; the per-bot list needs its bot id spread in, since it
 *  is addressed by a route the row itself doesn't carry. */
export interface HostLifecycleItem {
  bot_id: string;
  host_id: string;
  device_name: string;
  status: "pending" | "active" | "standby";
  online: boolean;
  revoked_at?: string | null;
}

/** Status as a sentence, not a column value. `status` alone is ambiguous — an
 *  host can be the designated active one while nothing is connected —
 *  so liveness and role are stated together (DESIGN.md bans raw enum names in
 *  UI copy). */
export function hostStatusLabel(item: HostLifecycleItem): string {
  if (item.revoked_at) return "Revoked";
  if (item.status === "pending") return "Waiting for pairing";
  if (item.online) return "Online";
  if (item.status === "active") return "Active, not connected";
  return "Standby";
}

/** Native MCP sign-in state in the words an operator would use. */
export function mcpStateLabel(state: string): string {
  switch (state) {
    case "connected":
      return "Signed in";
    case "action_required":
      return "Sign-in needed";
    case "authorizing":
      return "Signing in";
    case "refresh_failed":
      return "Sign-in expired";
    case "revoked":
      return "Revoked";
    default:
      return "Not signed in yet";
  }
}

export function mcpStateTone(state: string): "success" | "warning" | "muted" {
  if (state === "connected") return "success";
  if (state === "action_required" || state === "refresh_failed") return "warning";
  return "muted";
}

type Pending = "revoke" | "delete" | null;

/**
 * Every lifecycle operation a host has, in one place.
 *
 * Both surfaces that manage hosts — a bot's own Hosts tab and
 * Fleet → Hosts — used to implement these separately, which is why they
 * drifted: two different icons for the same operation, the same `Trash2` for
 * revoke and delete, and a revoked row that could only be cleared from Fleet.
 * They now render this.
 *
 * `presentation="labeled"` spells the actions out (roomy detail panel);
 * `presentation="compact"` is icon-only with accessible names (dense list row).
 */
export function HostActions({
  item,
  presentation = "labeled",
  onChanged,
}: {
  item: HostLifecycleItem;
  presentation?: "labeled" | "compact";
  /** Refetch the owning list once an operation lands. */
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [credential, setCredential] = useState<string | null>(null);

  async function run(operation: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await operation();
      notify.success(done);
      // Only on success: a failed operation leaves its confirm dialog open, so
      // retrying is one click rather than a hunt back through the row.
      setPending(null);
      await onChanged();
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    setBusy(true);
    try {
      const result = await rotateTerminalCredential(item.bot_id, item.host_id);
      setCredential(result.credential);
      await onChanged();
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const revoked = Boolean(item.revoked_at);
  const controls: ReactNode[] = [];

  if (revoked) {
    // A revoked host cannot connect again; the row is kept so the device
    // stays visible in history until someone clears it.
    controls.push(
      <Action
        key="delete"
        presentation={presentation}
        action="delete"
        accessibleLabel="Delete host record"
        icon={<Trash2 className="h-3.5 w-3.5" />}
        tone="danger"
        disabled={busy}
        onClick={() => setPending("delete")}
      />
    );
  } else {
    if (item.status === "standby") {
      controls.push(
        <Action
          key="activate"
          presentation={presentation}
          action="activate"
          accessibleLabel="Make this the active host"
          icon={<Power className="h-3.5 w-3.5" />}
          disabled={busy}
          onClick={() => void run(
            () => activateConnectorHost(item.bot_id, item.host_id),
            `${item.device_name} is now the active host`
          )}
        />
      );
    }
    if (item.status === "active") {
      controls.push(
        <Action
          key="reconnect"
          presentation={presentation}
          action="restart"
          accessibleLabel="Reconnect host"
          icon={<RefreshCw className="h-3.5 w-3.5" />}
          disabled={busy}
          onClick={() => void run(
            () => reconnectConnectorHost(item.bot_id, item.host_id),
            "Reconnect requested"
          )}
        />
      );
    }
    if (item.status !== "pending") {
      // Distinct from Reconnect on purpose: this mints a new secret and the old
      // one stops working, which is a different promise than "dial again".
      controls.push(
        <Action
          key="rotate"
          presentation={presentation}
          action="rotate"
          accessibleLabel="Issue a new credential"
          icon={<KeyRound className="h-3.5 w-3.5" />}
          disabled={busy}
          onClick={() => void rotate()}
        />
      );
    }
    controls.push(
      <Action
        key="revoke"
        presentation={presentation}
        action="revoke"
        accessibleLabel={item.status === "pending" ? "Cancel pending pairing" : "Revoke host"}
        icon={<Ban className="h-3.5 w-3.5" />}
        tone="danger"
        disabled={busy}
        onClick={() => setPending("revoke")}
      />
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">{controls}</div>

      {pending === "revoke" && (
        <ConfirmDialog
          title={item.status === "pending" ? "Cancel this pairing?" : "Revoke this host?"}
          confirmAction="revoke"
          confirmLabel={item.status === "pending" ? "Cancel pairing" : "Revoke"}
          busy={busy}
          onClose={() => setPending(null)}
          onConfirm={() => void run(
            () => revokeConnectorHost(item.bot_id, item.host_id),
            item.status === "pending" ? "Pairing cancelled" : `${item.device_name} revoked`
          )}
        >
          {item.status === "pending" ? (
            <p>
              The pairing code for <strong className="text-content-primary">{item.device_name}</strong>{" "}
              stops working. Nobody who already has it can use it.
            </p>
          ) : (
            <>
              <p>
                <strong className="text-content-primary">{item.device_name}</strong> loses its
                credential and can't connect again.
                {item.online && " It is connected right now and will be disconnected."}
              </p>
              <p className="text-content-muted">
                The row stays in the list so the device remains visible in history — you can delete
                it afterwards. Setting this device up again means pairing it from scratch.
              </p>
            </>
          )}
        </ConfirmDialog>
      )}

      {pending === "delete" && (
        <ConfirmDialog
          title="Delete this record?"
          confirmAction="delete"
          busy={busy}
          onClose={() => setPending(null)}
          onConfirm={() => void run(
            () => deleteHostRecord(item.bot_id, item.host_id),
            `${item.device_name} record deleted`
          )}
        >
          <p>
            Removes <strong className="text-content-primary">{item.device_name}</strong> from this
            list for good. It is already revoked, so nothing that is running changes.
          </p>
          <p className="text-content-muted">The audit log keeps its history either way.</p>
        </ConfirmDialog>
      )}

      {credential !== null && (
        <CredentialDialog
          deviceName={item.device_name}
          credential={credential}
          onClose={() => setCredential(null)}
        />
      )}
    </>
  );
}

/** One control, drawn to match its surface: spelled out where there is room,
 *  icon-only (with an accessible name) in a dense row. */
function Action({
  presentation,
  action,
  accessibleLabel,
  icon,
  tone,
  disabled,
  onClick,
}: {
  presentation: "labeled" | "compact";
  /** Registered action identity. It also supplies the visible word in the
   *  labeled variant — the registry owns that wording, not the call site. */
  action: "activate" | "restart" | "rotate" | "revoke" | "delete";
  /** Accessible name for the icon-only variant, which shows no word. */
  accessibleLabel: string;
  icon: ReactNode;
  tone?: "danger";
  disabled?: boolean;
  onClick: () => void;
}) {
  if (presentation === "compact") {
    return (
      <IconButton label={accessibleLabel} tone={tone} disabled={disabled} onClick={onClick}>
        {icon}
      </IconButton>
    );
  }
  return (
    <Button
      action={action}
      content="iconText"
      title={accessibleLabel}
      variant={tone === "danger" ? "danger" : "secondary"}
      controlSize="compact"
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </Button>
  );
}

/** A rotated credential is shown once and never again, so it gets a modal the
 *  user has to dismiss rather than a line that can scroll away unnoticed. */
function CredentialDialog({
  deviceName,
  credential,
  onClose,
}: {
  deviceName: string;
  credential: string;
  onClose: () => void;
}) {
  return (
    <Dialog title={`New credential for ${deviceName}`} onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-3">
        <p className="text-compact text-warning-200">
          Shown once. Write it to the host's credential file before reconnecting — the
          previous credential no longer works.
        </p>
        <code className="block select-all break-all rounded-sm bg-zinc-950 p-3 text-compact text-content-secondary">
          {credential}
        </code>
        <div className="flex justify-end">
          <CopyCredential value={credential} />
        </div>
      </div>
    </Dialog>
  );
}

function CopyCredential({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      action="copy"
      variant="secondary"
      controlSize="compact"
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => notify.error("Clipboard is blocked — select the text and copy manually."));
      }}
    >
      {copied ? "Copied" : "Copy credential"}
    </Button>
  );
}
