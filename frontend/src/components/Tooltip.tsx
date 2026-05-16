import type { ReactNode } from "react";

type TooltipPlacement = "top" | "bottom" | "left" | "right";

export function Tooltip({
  children,
  className,
  content,
  disabled = false,
  placement = "top",
}: {
  children: ReactNode;
  className?: string;
  content: ReactNode;
  disabled?: boolean;
  placement?: TooltipPlacement;
}) {
  if (disabled || !content) return <>{children}</>;

  return (
    <span className={`an-tooltip${className ? ` ${className}` : ""}`} data-placement={placement}>
      {children}
      <span className="an-tooltip-bubble" role="tooltip">
        {content}
      </span>
    </span>
  );
}
