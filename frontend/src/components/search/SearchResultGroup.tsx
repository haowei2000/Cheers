import type { ReactNode } from "react";
import type { SearchSelection } from "../../types";
import { SearchResultItem } from "./SearchResultItem";
import { groupTitle, itemKey } from "./searchResultUtils";

export type SearchSelectionGroup = {
  type: SearchSelection["type"];
  items: SearchSelection[];
};

export function SearchResultGroup({
  group,
  query,
  actionFor,
  onSelect,
}: {
  group: SearchSelectionGroup;
  query: string;
  actionFor: (selection: SearchSelection) => ReactNode;
  onSelect: (selection: SearchSelection) => void;
}) {
  return (
    <div>
      <div className="an-search-group">{groupTitle(group.type)}</div>
      {group.items.map((selection) => (
        <SearchResultItem
          key={itemKey(selection)}
          selection={selection}
          query={query}
          action={actionFor(selection)}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
