import { ChevronDown, ChevronRight, Info, Laptop } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/serverConfig";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { ItemGroup, ItemSection, OperationsItem } from "@/components/ui/item";
import { Tip } from "@/components/ui/tip";
import type { FleetHost } from "@/api/fleet";
import {
  HostActions,
  hostStatusLabel,
  mcpStateLabel,
} from "@/features/bots/hostLifecycle";
import { ConnectorManager } from "@/features/desktop/ConnectorManager";

export function FleetHosts({
  items,
  refresh,
}: {
  items: FleetHost[];
  refresh: () => Promise<void>;
}) {
  const [expandedHostId, setExpandedHostId] = useState<string | null>(null);

  return (
    <div className="space-y-7">
      <ItemSection
        label="Registered hosts"
        presentationLevel="medium"
        controlSize="regular"
      >
        {items.length === 0 ? (
          <EmptyState icon={Laptop} title="No hosts yet" hint="Use Add host to choose a bot and connect a device." />
        ) : (
          items.map((item) => (
            <ItemGroup key={item.host_id}>
              <OperationsItem
                containerRole="presentation"
                title={`${item.bot_name} · ${item.device_name}`}
                leading={<Laptop className="h-4 w-4 text-content-muted" />}
                status={
                  <span className={cn("text-compact", statusToneClass(item))}>
                    {hostStatusLabel(item)}
                  </span>
                }
                onDoubleClick={() => setExpandedHostId((id) => id === item.host_id ? null : item.host_id)}
                actions={(
                  <>
                    <Tip content={`${item.agent_type} · Agent sign-in: ${mcpStateLabel(item.mcp_connection_state)}`}>
                      <IconButton label={`Host connection details for ${item.device_name}`} controlSize="compact">
                        <Info className="h-3.5 w-3.5" />
                      </IconButton>
                    </Tip>
                    <HostActions item={item} presentation="compact" onChanged={refresh} />
                    <IconButton
                      label={`${expandedHostId === item.host_id ? "Hide" : "Show"} details for ${item.device_name}`}
                      controlSize="compact"
                      aria-expanded={expandedHostId === item.host_id}
                      selected={expandedHostId === item.host_id}
                      onClick={() => setExpandedHostId((id) => id === item.host_id ? null : item.host_id)}
                    >
                      {expandedHostId === item.host_id ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    </IconButton>
                  </>
                )}
              />
              {expandedHostId === item.host_id && (
                <div className="ml-8 mb-2 space-y-2 px-2 text-compact text-content-muted">
                  <p>Runtime {item.connector_version ?? "version unknown"} · {item.credential_prefix} · Last seen {item.last_seen_at ? new Date(item.last_seen_at).toLocaleString() : "never"}</p>
                  {item.mcp_last_seen_at && <p>Last MCP request {new Date(item.mcp_last_seen_at).toLocaleString()}</p>}
                </div>
              )}
            </ItemGroup>
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

/** Green only when connected; red means a configured active host is unavailable. */
function statusToneClass(item: FleetHost): string {
  if (item.online) return "text-success-400";
  if (item.revoked_at || item.status === "active") return "text-danger-400";
  if (item.status === "pending") return "text-warning-400";
  return "text-content-muted";
}
