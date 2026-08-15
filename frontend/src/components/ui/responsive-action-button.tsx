import { useEffect, useRef, useState } from "react";
import { ActionButton, type ActionButtonProps } from "./action-button";

export type ResponsiveActionButtonProps = ActionButtonProps & {
  /** Visible label used when the local container has enough inline space. */
  wideLabel: string;
  /** Minimum local width required before showing the icon + text variant. */
  wideMinWidth?: number;
  /** Classes applied to the measuring wrapper rather than the button. */
  containerClassName?: string;
};

/**
 * An action that adapts to its own container, not the viewport.
 *
 * This matters inside Workbench tables, toolbars, and resizable panels: a
 * viewport media query cannot tell whether one local cell has room for text.
 * The compact branch stays icon-only and keeps the accessible label.
 */
export function ResponsiveActionButton({
  wideLabel,
  wideMinWidth = 144,
  containerClassName,
  ...props
}: ResponsiveActionButtonProps) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [wide, setWide] = useState(false);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const update = () => setWide(element.getBoundingClientRect().width >= wideMinWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [wideMinWidth]);

  return (
    <span ref={containerRef} className={containerClassName}>
      {wide ? (
        <ActionButton {...props} wideLabel={wideLabel} controlWidth="fill" />
      ) : (
        <ActionButton {...props} />
      )}
    </span>
  );
}
