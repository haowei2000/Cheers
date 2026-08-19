import { History } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { ItemSection, OperationsItem } from "@/components/ui/item";
import type { FleetAuditEvent, FleetBot } from "@/api/fleet";

export function FleetAudit({ events, bots }: { events: FleetAuditEvent[]; bots: FleetBot[] }) {
  const names = new Map(bots.map((bot) => [bot.bot_id, bot.bot_name]));
  return (
    <ItemSection
      label="Audit timeline"
      description="Management, connection, ACP, and approval events for bots you manage."
      presentationLevel="max"
      controlSize="regular"
    >
      {events.length === 0 ? (
        <EmptyState icon={History} title="No audit events" hint="Bot and host changes will appear here." />
      ) : (
        events.map((event) => (
          <OperationsItem
            key={`${event.source}:${event.id}`}
            title={event.event_type.replaceAll(".", " · ").replaceAll("_", " ")}
            subtitle={[event.bot_id ? names.get(event.bot_id) ?? event.bot_id : null, new Date(event.created_at).toLocaleString()]
              .filter(Boolean)
              .join(" · ")}
            leading={<History className="h-4 w-4 text-content-muted" />}
            status={<span className="text-compact capitalize text-content-muted">{event.source}</span>}
          />
        ))
      )}
    </ItemSection>
  );
}
