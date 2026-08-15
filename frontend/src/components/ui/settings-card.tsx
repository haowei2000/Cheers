import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { SectionHead } from "./field";

export function SettingsSection({
  title,
  icon: Icon,
  children,
  className,
}: {
  title: ReactNode;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <SectionHead className="mb-4">
        {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
        {title}
      </SectionHead>
      {children}
    </section>
  );
}

export function SettingsCard({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-sm bg-zinc-900 p-6 max-md:p-4", className)}>
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-title text-content-secondary">{title}</p>
          {description && <div className="mt-1 text-caption">{description}</div>}
        </div>
        {actions && <div className="flex flex-shrink-0 items-center">{actions}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
