import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Check, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ControlSize } from "./control-size";
import { InputWithLeadingIcon } from "./input-with-leading-icon";
import { MenuOption } from "./menu-option";
import { PopoverPanel, usePopoverDismiss } from "./popover";
import { Spinner } from "./spinner";

export interface ComboboxOption {
  value: string;
  label: ReactNode;
  /** Searchable text when label is not a string, plus aliases or identifiers. */
  searchText?: string;
  leading?: ReactNode;
  disabled?: boolean;
}

function optionText(option: ComboboxOption): string {
  const label = typeof option.label === "string" || typeof option.label === "number"
    ? String(option.label)
    : "";
  return `${label} ${option.value} ${option.searchText ?? ""}`.trim();
}

export function filterComboboxOptions(options: ComboboxOption[], query: string): ComboboxOption[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return options;
  return options.filter((option) => optionText(option).toLocaleLowerCase().includes(normalized));
}

export function nextComboboxIndex(
  options: ComboboxOption[],
  current: number,
  direction: 1 | -1 | "first" | "last",
): number {
  if (!options.some((option) => !option.disabled)) return -1;
  if (direction === "first") return options.findIndex((option) => !option.disabled);
  if (direction === "last") {
    for (let index = options.length - 1; index >= 0; index -= 1) {
      if (!options[index]?.disabled) return index;
    }
    return -1;
  }
  let index = current;
  for (let attempts = 0; attempts < options.length; attempts += 1) {
    index = (index + direction + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

export function Combobox({
  value,
  options,
  onValueChange,
  ariaLabel,
  placeholder = "Search options…",
  loading = false,
  loadingLabel = "Loading options…",
  noResultsLabel = "No matching options",
  controlSize,
  controlWidth = "fill",
  disabled = false,
  placement = "down",
  className,
  menuClassName,
}: {
  value?: string | null;
  options: ComboboxOption[];
  onValueChange: (value: string | null) => void;
  ariaLabel: string;
  placeholder?: string;
  loading?: boolean;
  loadingLabel?: string;
  noResultsLabel?: string;
  controlSize?: ControlSize;
  controlWidth?: "slot" | "fill";
  disabled?: boolean;
  placement?: "up" | "down";
  className?: string;
  menuClassName?: string;
}) {
  const selected = options.find((option) => option.value === value);
  const selectedLabel = selected && (typeof selected.label === "string" || typeof selected.label === "number")
    ? String(selected.label)
    : selected?.searchText ?? "";
  const [query, setQuery] = useState(selectedLabel);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const typingRef = useRef(false);
  const listboxId = useId();
  const optionIdPrefix = useId();
  const filterQuery = typingRef.current ? query : "";
  const filtered = useMemo(() => filterComboboxOptions(options, filterQuery), [filterQuery, options]);

  useEffect(() => {
    if (!typingRef.current) setQuery(selectedLabel);
  }, [selectedLabel, value]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = filtered.findIndex((option) => option.value === value && !option.disabled);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : nextComboboxIndex(filtered, -1, "first"));
  }, [filtered, open, value]);

  const closeAndRestore = () => {
    typingRef.current = false;
    setQuery(selectedLabel);
    setOpen(false);
  };

  usePopoverDismiss(open, closeAndRestore, rootRef);

  const choose = (option: ComboboxOption) => {
    if (option.disabled) return;
    const label = typeof option.label === "string" || typeof option.label === "number"
      ? String(option.label)
      : option.searchText ?? option.value;
    typingRef.current = false;
    setQuery(label);
    onValueChange(option.value);
    setOpen(false);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closeAndRestore();
      return;
    }
    if (event.key === "Enter" && open && activeIndex >= 0) {
      event.preventDefault();
      const option = filtered[activeIndex];
      if (option) choose(option);
      return;
    }
    const direction = event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowUp"
        ? -1
        : event.key === "Home"
          ? "first"
          : event.key === "End"
            ? "last"
            : null;
    if (direction === null) return;
    event.preventDefault();
    setOpen(true);
    setActiveIndex((current) => nextComboboxIndex(filtered, current, direction));
  };

  const activeOption = activeIndex >= 0 ? filtered[activeIndex] : undefined;

  return (
    <div
      ref={rootRef}
      data-combobox=""
      className={cn("relative min-w-0", controlWidth === "fill" ? "w-full" : "w-32 max-w-full", className)}
    >
      <InputWithLeadingIcon
        ref={inputRef}
        leading={<Search />}
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && activeOption ? `${optionIdPrefix}-${activeIndex}` : undefined}
        autoComplete="off"
        value={query}
        placeholder={placeholder}
        disabled={disabled}
        controlSize={controlSize}
        onFocus={() => setOpen(true)}
        onBlur={() => window.requestAnimationFrame(() => {
          if (document.activeElement !== inputRef.current) closeAndRestore();
        })}
        onChange={(event) => {
          typingRef.current = true;
          setQuery(event.target.value);
          onValueChange(null);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <PopoverPanel placement={placement} className={cn("w-72 max-w-[calc(100vw-1rem)] overflow-y-auto p-1", menuClassName)}>
          <div
            id={listboxId}
            role="listbox"
            tabIndex={-1}
            aria-label={ariaLabel}
            aria-busy={loading || undefined}
            onMouseDown={(event) => event.preventDefault()}
          >
            {loading ? (
              <div role="status" className="flex min-h-9 items-center gap-2 px-2 text-compact text-content-muted">
                <Spinner contentSize="small" />
                {loadingLabel}
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-compact text-content-muted">{noResultsLabel}</p>
            ) : filtered.map((option, index) => {
              const optionSelected = option.value === value;
              const active = index === activeIndex;
              return (
                <MenuOption
                  key={option.value}
                  id={`${optionIdPrefix}-${index}`}
                  role="option"
                  aria-selected={optionSelected}
                  selected={active || optionSelected}
                  disabled={option.disabled}
                  controlSize="regular"
                  label={option.label}
                  leading={option.leading}
                  trailing={optionSelected ? <Check className="h-4 w-4" aria-hidden="true" /> : undefined}
                  onPointerMove={() => setActiveIndex(index)}
                  onClick={() => choose(option)}
                />
              );
            })}
          </div>
        </PopoverPanel>
      )}
    </div>
  );
}
