import { useState } from "react";
import { Laptop, Play, RefreshCw, RotateCw, ShieldAlert, Trash2 } from "lucide-react";
import toast from "react-hot-toast";

import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/serverConfig";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog } from "@/components/ui/dialog";
import { ItemSection, OperationsItem } from "@/components/ui/item";
import { IconButton } from "@/components/ui/icon-button";
import {
  activateTerminalInstallation,
  reconnectTerminalInstallation,
  revokeTerminalInstallation,
  rotateTerminalCredential,
} from "@/api/bots";
import type { FleetInstallation } from "@/api/fleet";
import { CopyButton } from "@/features/bots/BotDetailPanel";
import { ConnectorManager } from "@/features/desktop/ConnectorManager";

export function FleetInstallations({
  items,
  refresh,
}: {
  items: FleetInstallation[];
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ device: string; credential: string } | null>(null);

  async function act(item: FleetInstallation, operation: () => Promise<unknown>, message: string) {
    setBusy(item.installation_id);
    try {
      await operation();
      toast.success(message);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Operation failed");
    } finally {
      setBusy(null);
    }
  }

  async function rotate(item: FleetInstallation) {
    setBusy(item.installation_id);
    try {
      const result = await rotateTerminalCredential(item.bot_id, item.installation_id);
      setIssued({ device: item.device_name, credential: result.credential });
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't rotate credential");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-7">
      <ItemSection
        label="Registered installations"
        description="Device registrations and credentials managed by the Cheers server."
        presentationLevel="max"
        controlSize="regular"
      >
        {items.length === 0 ? (
          <EmptyState icon={Laptop} title="No installations yet" hint="Use Add installation to choose a bot and connect a device." />
        ) : (
          items.map((item) => (
            <OperationsItem
              key={item.installation_id}
              title={`${item.bot_name} · ${item.device_name}`}
              subtitle={`${item.agent_type} · ${item.credential_prefix}`}
              metadata={`Last seen ${
                item.last_seen_at ? new Date(item.last_seen_at).toLocaleString() : "never"
              } · MCP ${item.mcp_connection_state.replaceAll("_", " ")}`}
              leading={<Laptop className="h-4 w-4 text-content-muted" />}
              status={
                <span className={cn("text-compact", item.online ? "text-success-400" : "text-content-muted")}>
                  {item.revoked_at ? "Revoked" : item.online ? "Online" : item.status}
                </span>
              }
              actions={
                item.revoked_at ? undefined : (
                  <>
                    {item.status === "standby" && (
                      <IconButton
                        label="Activate installation"
                        disabled={busy === item.installation_id}
                        onClick={() =>
                          void act(
                            item,
                            () => activateTerminalInstallation(item.bot_id, item.installation_id),
                            "Installation activated",
                          )
                        }
                      >
                        <Play className="h-4 w-4" />
                      </IconButton>
                    )}
                    {item.status !== "pending" && (
                      <IconButton
                        label="Rotate credential"
                        disabled={busy === item.installation_id}
                        onClick={() => void rotate(item)}
                      >
                        <RotateCw className="h-4 w-4" />
                      </IconButton>
                    )}
                    {item.status === "active" && (
                      <IconButton
                        label="Reconnect installation"
                        disabled={busy === item.installation_id}
                        onClick={() =>
                          void act(
                            item,
                            () => reconnectTerminalInstallation(item.bot_id, item.installation_id),
                            "Reconnect requested",
                          )
                        }
                      >
                        <RefreshCw className="h-4 w-4" />
                      </IconButton>
                    )}
                    <IconButton
                      label="Revoke installation"
                      tone="danger"
                      disabled={busy === item.installation_id}
                      onClick={() => {
                        if (window.confirm(`Revoke installation “${item.device_name}”?`)) {
                          void act(
                            item,
                            () => revokeTerminalInstallation(item.bot_id, item.installation_id),
                            "Installation revoked",
                          );
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </>
                )
              }
            />
          ))
        )}
      </ItemSection>
      {isTauri() && (
        <section className="space-y-3">
          <div>
            <h2 className="font-utility text-compact font-semibold uppercase tracking-overline text-content-muted">This Mac</h2>
            <p className="mt-1 text-compact text-content-muted">Local connector processes, logs, workspaces, and runtime health.</p>
          </div>
          <ConnectorManager />
        </section>
      )}
      {issued && (
        <Dialog title={`Credential for ${issued.device}`} onClose={() => setIssued(null)} maxWidth="max-w-lg">
          <div className="space-y-3">
            <p className="text-compact text-warning-200">This credential is shown once. Replace the installation credential before reconnecting.</p>
            <code className="block break-all rounded-sm bg-zinc-950 p-3 text-compact text-content-secondary select-all">
              {issued.credential}
            </code>
            <CopyButton value={issued.credential} />
          </div>
        </Dialog>
      )}
    </div>
  );
}
