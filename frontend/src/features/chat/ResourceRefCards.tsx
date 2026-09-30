import { useContext } from "react";
import { ArrowUpRight, Link2 } from "lucide-react";
import { LocatorOpenContext, canOpenLocator } from "./messageLinks";

export interface ResourceRefCard {
  v: 1;
  kind: "resource_ref";
  uri: string;
  title?: string;
  description?: string;
}

/** Treat persisted Bot content as untrusted, including older gateway records. */
export function resourceRefCards(contentData: unknown): ResourceRefCard[] {
  if (!contentData || typeof contentData !== "object" || Array.isArray(contentData)) return [];
  const cards = (contentData as Record<string, unknown>).cards;
  if (!Array.isArray(cards)) return [];
  return cards.slice(0, 3).flatMap((raw): ResourceRefCard[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const card = raw as Record<string, unknown>;
    if (card.v !== 1 || card.kind !== "resource_ref" || typeof card.uri !== "string" || !canOpenLocator(card.uri)) return [];
    if (card.title !== undefined && (typeof card.title !== "string" || card.title.length > 120)) return [];
    if (card.description !== undefined && (typeof card.description !== "string" || card.description.length > 240)) return [];
    return [{
      v: 1,
      kind: "resource_ref",
      uri: card.uri,
      ...(typeof card.title === "string" ? { title: card.title } : {}),
      ...(typeof card.description === "string" ? { description: card.description } : {}),
    }];
  });
}

export function ResourceRefCards({ cards }: { cards: ResourceRefCard[] }) {
  const openLocator = useContext(LocatorOpenContext);
  if (!cards.length || !openLocator) return null;
  return (
    <div className="mt-2 flex max-w-xl flex-col gap-2" aria-label="Linked resources">
      {cards.map((card) => (
        <a
          key={card.uri}
          href={`#workspace-ref-${encodeURIComponent(card.uri)}`}
          className="group flex min-h-11 min-w-0 items-center gap-3 rounded-sm bg-control px-3 py-2 font-utility text-content-primary transition-colors hover:bg-control-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
          onClick={(event) => { event.preventDefault(); openLocator(card.uri); }}
          aria-label={`Open ${card.title || card.uri}`}
          title={card.uri}
        >
          <Link2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-regular font-semibold">{card.title || card.uri}</span>
            {card.description && <span className="block truncate text-compact text-content-secondary">{card.description}</span>}
            {card.title && <span className="block truncate font-code text-compact text-content-muted">{card.uri}</span>}
          </span>
          <ArrowUpRight className="h-4 w-4 shrink-0 text-content-muted group-hover:text-content-primary" aria-hidden="true" />
        </a>
      ))}
    </div>
  );
}
