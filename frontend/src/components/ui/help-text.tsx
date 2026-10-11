import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tip } from "./tip";

/** Supplementary copy is requested through hover, keyboard focus or a tap. */
export function HelpText({ children, label = "More information", className }: {
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return <Tip content={children} label={label} align="start" className={className} />;
}

/** Keep names and labels visible; place their explanation beside them. */
export function HelpLabel({ children, help, helpLabel, className }: {
  children: ReactNode;
  help?: ReactNode;
  helpLabel?: string;
  className?: string;
}) {
  return <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
    {children}
    {help && <HelpText label={helpLabel ?? (typeof children === "string" ? `About ${children}` : "More information")}>{help}</HelpText>}
  </span>;
}
