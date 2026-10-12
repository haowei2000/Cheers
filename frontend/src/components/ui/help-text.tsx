import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tip } from "./tip";

/** The existing title or label itself owns supplementary help. No extra control. */
export function HelpLabel({ children, help, helpLabel, className }: {
  children: ReactNode;
  help?: ReactNode;
  helpLabel?: string;
  className?: string;
}) {
  const text = <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>{children}</span>;
  return help ? <Tip content={help} label={helpLabel} textTrigger align="start" className={cn("min-w-0", className)}>{text}</Tip> : text;
}
