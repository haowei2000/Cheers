import type { SearchResultType } from "../../types";

export type SearchTypeFilterOption = {
  type: SearchResultType;
  label: string;
};

export function SearchFilters({
  options,
  activeTypes,
  onToggle,
}: {
  options: SearchTypeFilterOption[];
  activeTypes: SearchResultType[];
  onToggle: (type: SearchResultType) => void;
}) {
  if (options.length === 0) return null;

  const activeTypeSet = new Set(activeTypes);
  return (
    <div className="an-search-filters" role="group" aria-label="Search types">
      {options.map((option) => {
        const selected = activeTypeSet.has(option.type);
        return (
          <button
            key={option.type}
            type="button"
            className="an-search-filter"
            data-active={selected ? "1" : undefined}
            aria-pressed={selected}
            onClick={() => onToggle(option.type)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
