import { Laptop } from "lucide-react";

import { isTauri } from "@/lib/serverConfig";
import { EmptyState } from "@/components/ui/empty-state";
import { ItemSection } from "@/components/ui/item";
import type { FleetHost } from "@/api/fleet";
import { HostItem } from "@/features/bots/HostItem";
import { ConnectorManager } from "@/features/desktop/ConnectorManager";

export function FleetHosts({
  items,
  refresh,
}: {
  items: FleetHost[];
  refresh: () => Promise<void>;
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
          <EmptyState icon={Laptop} title="No hosts yet" hint="Use Add host to choose a bot and connect a device." />
        ) : (
          items.map((item) => <HostItem key={item.host_id} item={item} onChanged={refresh} />)
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
