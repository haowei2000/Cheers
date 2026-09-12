import { IconButton } from "@/components/ui/icon-button";
import { useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Ban,
  ChevronRight,
  Clock3,
  Copy,
  Laptop,
  PauseCircle,
  Wifi,
  WifiOff,
} from "lucide-react";
import { listConnectorHosts, type ConnectorHost } from "@/api/bots";
import { Avatar } from "@/components/ui/avatar";
import { ActionButton } from "@/components/ui/action-button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Dialog } from "@/components/ui/dialog";
import { MetaRow, SectionHead } from "@/components/ui/field";
import { OperationsItem } from "@/components/ui/item";
import { Tip } from "@/components/ui/tip";
import { cn } from "@/lib/cn";
import { messageOf, notify } from "@/lib/notify";
import {
  HostActions,
  hostStatusLabel,
  mcpStateLabel,
  mcpStateTone,
  type HostLifecycleItem,
} from "./hostLifecycle";

export type HostItemData = HostLifecycleItem & {
  agent_type: string;
  credential_prefix: string;
  created_at: string;
  connector_version?: string | null;
  last_seen_at?: string | null;
  connected_at?: string | null;
  mcp_connection_state: string;
  mcp_state_updated_at?: string | null;
  mcp_connected_at?: string | null;
  mcp_last_seen_at?: string | null;
  bot_name?: string;
};

export function hostIndicator(item: HostLifecycleItem) {
  if (item.revoked_at)
    return { label: "Revoked", Icon: Ban, tone: "text-content-muted" };
  if (item.status === "pending")
    return { label: "Pairing", Icon: Clock3, tone: "text-warning-400" };
  if (item.online)
    return { label: "Online", Icon: Wifi, tone: "text-success-400" };
  if (item.status === "standby")
    return { label: "Standby", Icon: PauseCircle, tone: "text-content-muted" };
  return { label: "Offline", Icon: WifiOff, tone: "text-content-muted" };
}

/** One navigation action per row. Lifecycle controls belong to the detail view,
 * so the entire host remains a keyboard-accessible button without nested buttons. */
export function HostItem({
  item,
  onChanged,
}: {
  item: HostItemData;
  onChanged: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const { Icon, label, tone } = hostIndicator(item);
  const needsSignIn =
    !item.revoked_at && mcpStateTone(item.mcp_connection_state) === "warning";
  return (
    <>
      <OperationsItem
        title={item.device_name}
        aria-label={`View host ${item.device_name}${item.bot_name ? ` for ${item.bot_name}` : ""}. ${hostStatusLabel(item)}${needsSignIn ? `. ${mcpStateLabel(item.mcp_connection_state)}` : ""}`}
        leading={
          <Tip
            content={`${item.bot_name ?? item.agent_type} · ${item.agent_type}`}
          >
            <span className="inline-flex items-center gap-2">
              <Laptop
                className="h-4 w-4 text-content-muted"
                aria-hidden="true"
              />
              <Avatar
                name={item.bot_name ?? item.agent_type}
                id={item.bot_id}
                size="small"
              />
            </span>
          </Tip>
        }
        criticalStatus={
          <span className="inline-flex shrink-0 items-center gap-2">
            <Tip content={hostStatusLabel(item)}>
              <span
                className={cn(
                  "inline-flex items-center gap-1 text-compact",
                  tone,
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                <span>{label}</span>
              </span>
            </Tip>
            {needsSignIn && (
              <Tip content={mcpStateLabel(item.mcp_connection_state)}>
                <span
                  className="inline-flex text-warning-400"
                  role="img"
                  aria-label={mcpStateLabel(item.mcp_connection_state)}
                >
                  <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                </span>
              </Tip>
            )}
          </span>
        }
        trailing={
          <ChevronRight
            className="h-4 w-4 text-content-muted"
            aria-hidden="true"
          />
        }
        onClick={() => setOpen(true)}
      />
      {open && (
        <HostDetailDialog
          item={item}
          onClose={() => setOpen(false)}
          onChanged={onChanged}
        />
      )}
    </>
  );
}

export function HostDetailDialog({
  item,
  onClose,
  onChanged,
}: {
  item: HostItemData;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [details, setDetails] = useState<ConnectorHost | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void listConnectorHosts(item.bot_id)
      .then((hosts) => {
        if (cancelled) return;
        const found = hosts.find((host) => host.host_id === item.host_id);
        if (!found) {
          setError("This host is no longer registered. Refresh the host list.");
          return;
        }
        setDetails(found);
      })
      .catch((error) => {
        if (!cancelled) setError(messageOf(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.bot_id, item.host_id, revision]);
  const host = { ...item, ...details };
  const status = hostIndicator(host);
  const refresh = async () => {
    setRevision((value) => value + 1);
    try {
      await onChanged();
    } catch (error) {
      notify.error(messageOf(error));
    }
  };
  return (
    <Dialog title="Host details" onClose={onClose} maxWidth="max-w-2xl">
      <div className="space-y-5">
        <div className="flex items-start gap-3">
          <Laptop
            className="h-5 w-5 shrink-0 text-content-muted"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <h2 className="break-words font-utility text-comfortable font-semibold text-content-primary">
              {host.device_name}
            </h2>
            <p
              className={cn(
                "mt-1 flex items-center gap-2 text-compact",
                status.tone,
              )}
            >
              <status.Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {hostStatusLabel(host)}
            </p>
          </div>
          <ButtonGroup label="Host detail controls">
            <ActionButton
              action="refresh"
              context="windowChrome"
              accessibleLabel="Refresh host details"
              disabled={loading}
              onClick={() => void refresh()}
            />
          </ButtonGroup>
        </div>
        {loading && (
          <p role="status" className="text-compact text-content-muted">
            Refreshing host details…
          </p>
        )}
        {error && (
          <p role="alert" className="text-compact text-danger-400">
            {error}
          </p>
        )}
        <section className="space-y-3">
          <SectionHead>Device</SectionHead>
          {item.bot_name && <Detail label="Bot">{item.bot_name}</Detail>}
          <Detail label="Agent">
            {details?.agent_profile?.display_name ?? host.agent_type}
          </Detail>
          <Detail label="Connector">
            {host.connector_version ?? "Version unknown"}
          </Detail>
          <Detail label="Host ID" copy={host.host_id}>
            {host.host_id}
          </Detail>
          <Detail label="Bot ID" copy={host.bot_id}>
            {host.bot_id}
          </Detail>
          <Detail label="Key prefix">{host.credential_prefix}</Detail>
          {details?.credential_rotated_at && (
            <Detail label="Key rotated">
              {dateLabel(details.credential_rotated_at)}
            </Detail>
          )}
          <Detail label="Registered">{dateLabel(host.created_at)}</Detail>
          {host.revoked_at && (
            <Detail label="Revoked">{dateLabel(host.revoked_at)}</Detail>
          )}
        </section>
        <section className="space-y-3">
          <SectionHead>Connection</SectionHead>
          <Detail label="Last connected">{dateLabel(host.connected_at)}</Detail>
          <Detail label="Last seen">{dateLabel(host.last_seen_at)}</Detail>
          <Detail label="Agent sign-in">
            {mcpStateLabel(host.mcp_connection_state)}
          </Detail>
          <Detail label="Sign-in updated">
            {dateLabel(host.mcp_state_updated_at)}
          </Detail>
          <Detail label="Last sign-in">
            {dateLabel(host.mcp_connected_at)}
          </Detail>
          <Detail label="Last request">
            {dateLabel(host.mcp_last_seen_at)}
          </Detail>
          {details?.agent_profile?.verified_version_range && (
            <Detail label="Verified versions">
              {details.agent_profile.verified_version_range}
            </Detail>
          )}
          {!host.revoked_at &&
            host.mcp_connection_state !== "connected" &&
            details?.agent_profile?.login_hint && (
              <p className="whitespace-pre-wrap break-words rounded-sm bg-zinc-800/60 p-3 text-compact text-content-secondary">
                {details.agent_profile.login_hint}
              </p>
            )}
        </section>
        <section className="space-y-3">
          <SectionHead>Manage host</SectionHead>
          {!error && <HostActions item={host} onChanged={refresh} />}
        </section>
      </div>
    </Dialog>
  );
}

function dateLabel(value?: string | null) {
  return value ? new Date(value).toLocaleString() : "Never";
}
function Detail({
  label,
  children,
  copy,
}: {
  label: string;
  children: ReactNode;
  copy?: string;
}) {
  return (
    <MetaRow label={label}>
      <span className="min-w-0 flex-1 break-all text-content-secondary">
        {children}
      </span>
      {copy && (
        <ButtonGroup label={`${label} actions`}>
          <IconButton
            label={`Copy ${label}`}
            onClick={() => {
              void navigator.clipboard
                .writeText(copy)
                .then(() => notify.success(`${label} copied`))
                .catch(() => notify.error("Could not copy to clipboard"));
            }}
          >
            <Copy className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </ButtonGroup>
      )}
    </MetaRow>
  );
}
