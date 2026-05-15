import type { SearchResultType } from "../../types";
import { SearchFilters, type SearchTypeFilterOption } from "./SearchFilters";

type ScopeOption = {
  value: string;
  label: string;
  title?: string;
  marker?: string;
};

export function SearchScopeMenu({
  options,
  value,
  onSelect,
  typeOptions = [],
  activeTypes = [],
  onTypeToggle,
}: {
  options: ScopeOption[];
  value?: string;
  onSelect: (value: string) => void;
  typeOptions?: SearchTypeFilterOption[];
  activeTypes?: SearchResultType[];
  onTypeToggle?: (type: SearchResultType) => void;
}) {
  const hasScopeOptions = options.length > 0;
  const hasTypeOptions = typeOptions.length > 0 && Boolean(onTypeToggle);

  if (!hasScopeOptions && !hasTypeOptions) return null;

  return (
    <div className="an-search-scope-pop" role="dialog" aria-label="搜索设置">
      {hasScopeOptions && (
        <div className="an-search-settings-section" role="radiogroup" aria-label="搜索范围">
          <div className="an-search-settings-heading">范围</div>
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value || "__all__"}
                type="button"
                role="radio"
                aria-checked={selected}
                className="an-search-scope-option"
                data-active={selected ? "1" : undefined}
                title={option.title || option.label}
                onClick={() => onSelect(option.value)}
              >
                <span className="an-search-scope-option-mark">{option.marker || "∗"}</span>
                <span className="an-search-scope-option-text">
                  <span className="an-search-scope-option-name">{option.label}</span>
                  {option.title && (
                    <span className="an-search-scope-option-sub">{option.title}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {hasTypeOptions && onTypeToggle && (
        <div className="an-search-settings-section">
          <div className="an-search-settings-heading">类型</div>
          <SearchFilters
            options={typeOptions}
            activeTypes={activeTypes}
            onToggle={onTypeToggle}
          />
        </div>
      )}
    </div>
  );
}
