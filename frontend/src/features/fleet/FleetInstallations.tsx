import { Laptop } from "lucide-react";

import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/serverConfig";
import { EmptyState } from "@/components/ui/empty-state";
import { ItemSection, OperationsItem } from "@/components/ui/item";
import type { FleetInstallation } from "@/api/fleet";
import {
  InstallationActions,
  installationStatusLabel,
  mcpStateLabel,
  mcpStateTone,
} from "@/features/bots/installationLifecycle";
import { ConnectorManager } from "@/features/desktop/ConnectorManager";

export function FleetInstallations({
  items,
  refresh,
}: {
  items: FleetInstallation[];
  refresh: () => Promise<void>;
}) {
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
              } · Agent sign-in: ${mcpStateLabel(item.mcp_connection_state)}`}
              leading={<Laptop className="h-4 w-4 text-content-muted" />}
              status={
                <span className={cn("text-compact", statusToneClass(item))}>
                  {installationStatusLabel(item)}
                </span>
              }
              actions={<InstallationActions item={item} presentation="compact" onChanged={refresh} />}
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
    </div>
  );
}

/** Green only when it is actually connected; amber when the operator has
 *  something to do. Everything else is neutral. */
function statusToneClass(item: FleetInstallation): string {
  if (item.revoked_at) return "text-content-muted";
  if (item.online) return "text-success-400";
  if (mcpStateTone(item.mcp_connection_state) === "warning") return "text-warning-400";
  return "text-content-muted";
}
