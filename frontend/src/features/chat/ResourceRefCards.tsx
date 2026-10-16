import { useContext } from "react";
import { ResourceEnclosure } from "./ResourceEnclosure";
import { LocatorOpenContext, canOpenLocator } from "./messageLinks";
import { ResourceInlinePreview } from "./ResourceInlinePreview";

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
    <div className="resource-enclosures my-4 flex min-w-0 max-w-xl flex-col gap-4" aria-label="Linked resources">
      {cards.map((card,index) => (
        <ResourceEnclosure key={card.uri} uri={card.uri} title={card.title} description={card.description} number={index+1}>
          <ResourceInlinePreview uri={card.uri} />
        </ResourceEnclosure>
      ))}
    </div>
  );
}
