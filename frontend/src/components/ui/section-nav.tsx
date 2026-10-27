import { useEffect, useRef, type ComponentType, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { ItemList, NavigationItem } from "./item";
import { tabClasses } from "./selection";

export interface SectionNavItem<Id extends string> {
  id: Id;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Count or state that must stay visible (pending requests, approvals). */
  badge?: ReactNode;
}

/**
 * Page-level section switcher (Settings, Fleet, Friends). Sections change the
 * URL, so every entry is navigation with `aria-current="page"`, not a tab.
 *
 * Desktop: a vertical rail of NavigationItems. Phone: the rail does not fit
 * beside the content, and laid sideways it kept the row's left marker and
 * dividers; it becomes a scrolling row with the shared tab underline, and the
 * current section scrolls into view so a clipped one is never the selected one.
 */
export function SectionNav<Id extends string>({
  ariaLabel,
  items,
  selected,
  onSelect,
}: {
  ariaLabel: string;
  items: readonly SectionNavItem<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const current = rowRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selected]);

  return (
    <nav aria-label={ariaLabel} className="min-w-0 sm:w-48 sm:shrink-0">
      <ItemList presentationLevel="minimal" controlSize="regular" className="flex flex-col max-sm:hidden">
        {items.map(({ id, label, icon: Icon, badge }) => (
          <NavigationItem
            key={id}
            title={label}
            leading={<Icon className="h-4 w-4" aria-hidden="true" />}
            selected={id === selected}
            criticalStatus={badge}
            onClick={() => onSelect(id)}
          />
        ))}
      </ItemList>
      <div ref={rowRef} className="flex overflow-x-auto border-b border-control/80 no-scrollbar sm:hidden">
        {items.map(({ id, label, icon: Icon, badge }) => {
          const current = id === selected;
          return (
            <Button
              key={id}
              variant="plain"
              controlWidth="content"
              controlSize="regular"
              aria-current={current ? "page" : undefined}
              onClick={() => onSelect(id)}
              className={cn("-mb-px shrink-0", tabClasses(current))}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
              {badge}
            </Button>
          );
        })}
      </div>
    </nav>
  );
}
