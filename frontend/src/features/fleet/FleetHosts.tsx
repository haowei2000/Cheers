import { HelpLabel } from "@/components/ui/help-text";
import { Button } from "@/components/ui/button";
import { Laptop, Plus } from "lucide-react";

import { isTauri } from "@/lib/serverConfig";
import { EmptyState } from "@/components/ui/empty-state";
import { ItemSection } from "@/components/ui/item";
import type { FleetHost } from "@/api/fleet";
import { HostItem } from "@/features/bots/HostItem";
import { ConnectorManager } from "@/features/desktop/ConnectorManager";

export function FleetHosts({
  items,
  refresh,
  onAddHost,
}: {
  items: FleetHost[];
  refresh: () => Promise<void>;
  onAddHost: () => void;
}) {
  return (
    <div className="space-y-7">
      <ItemSection
        label="Registered hosts"
        description="Device registrations and credentials managed by the Cheers server."
        presentationLevel="medium"
        controlSize="regular"
      >
        {items.length === 0 ? (
          <EmptyState
            icon={Laptop}
            title="No hosts yet"
            hint="Choose a bot and connect the device that will run it."
            action={<Button action="add" content="iconText" variant="secondary" onClick={onAddHost}><Plus /></Button>}
          />
        ) : (
          items.map((item) => <HostItem key={item.host_id} item={item} onChanged={refresh} />)
        )}
      </ItemSection>
      {isTauri() && (
        <section className="space-y-3">
          <div>
            <h2 className="font-utility text-compact font-semibold uppercase tracking-overline text-content-muted"><HelpLabel help={<>Local connector processes, logs, workspaces, and runtime health.</>}>This Mac</HelpLabel></h2>

          </div>
          <ConnectorManager />
        </section>
      )}
    </div>
  );
}
