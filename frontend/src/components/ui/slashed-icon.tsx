import { forwardRef, type ComponentType, type SVGProps } from "react";
import { cn } from "@/lib/cn";
import { createLucideIcon, EyeOff } from "lucide-react";

/**
 * Top-left to bottom-right diagonal strikethrough path (m2 2 20 20),
 * adhering to Lucide's 24x24 icon grid convention.
 */
export const SLASH_PATH = "m2 2 20 20";

/**
 * LockOff icon for the Cheers design system: a lock glyph carrying a top-left to
 * bottom-right diagonal strikethrough indicating "Unlocked / Not Locked".
 *
 * In Cheers, boolean toggle actions (such as lock or preview) do not use background
 * color fill highlights. Instead, they use a clean icon for "On / Enabled / Locked"
 * and a top-left to bottom-right diagonal strikethrough icon for "Off / Disabled / Unlocked".
 */
export const LockOff = createLucideIcon("LockOff", [
  ["rect", { width: "18", height: "11", x: "3", y: "11", rx: "2", ry: "2", key: "rect" }],
  ["path", { d: "M7 11V7a5 5 0 0 1 10 0v4", key: "shackle" }],
  ["path", { d: SLASH_PATH, key: "slash" }],
]);

export { EyeOff };

export interface SlashedIconProps extends SVGProps<SVGSVGElement> {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  slashed?: boolean;
}

/**
 * Renders an icon with an optional top-left to bottom-right diagonal strikethrough (`\`).
 * When `slashed` is false (or omitted when not active), the base icon renders normally.
 * When `slashed` is true, an overlaid diagonal strikethrough is rendered atop the icon.
 */
export const SlashedIcon = forwardRef<HTMLSpanElement, SlashedIconProps>(
  ({ icon: Icon, slashed = true, className, ...props }, ref) => {
    if (!slashed) {
      return <Icon className={className} {...props} />;
    }
    return (
      <span ref={ref} className={cn("relative inline-flex items-center justify-center", className)}>
        <Icon className="h-full w-full flex-shrink-0" aria-hidden="true" {...props} />
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="pointer-events-none absolute inset-0 h-full w-full flex-shrink-0"
          aria-hidden="true"
        >
          <path d={SLASH_PATH} />
        </svg>
      </span>
    );
  },
);
SlashedIcon.displayName = "SlashedIcon";

/**
 * Higher-order component to produce a slashed version of any icon component.
 */
export function withSlash<P extends SVGProps<SVGSVGElement> = SVGProps<SVGSVGElement>>(
  Icon: ComponentType<P>,
): ComponentType<P> {
  const Slashed = forwardRef<HTMLSpanElement, P>(({ className, ...props }, ref) => {
    const iconProps = {
      ...props,
      className: "h-full w-full flex-shrink-0",
      "aria-hidden": true,
    } as unknown as P;

    return (
      <span ref={ref} className={cn("relative inline-flex items-center justify-center", className)}>
        <Icon {...iconProps} />
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="pointer-events-none absolute inset-0 h-full w-full flex-shrink-0"
          aria-hidden="true"
        >
          <path d={SLASH_PATH} />
        </svg>
      </span>
    );
  });
  Slashed.displayName = `WithSlash(${Icon.displayName || Icon.name || "Icon"})`;
  return Slashed as unknown as ComponentType<P>;
}
