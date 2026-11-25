import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { HelpLabel } from "./help-text";
import { ButtonGroup } from "./button-group";
import { controlMinHeightClasses } from "./control-size";

export function SettingsSection({
  title,
  icon: Icon,
  children,
  className,
  actions,
}: {
  title: ReactNode;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}) {
  return (
    <section className={className}>
      <header className={cn("mb-4 flex min-w-0 items-center gap-2", controlMinHeightClasses.regular)}>
        <h2 className="flex min-w-0 items-center gap-2 text-section-label">
          {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
          {title}
        </h2>
        {actions && <ButtonGroup label={`${typeof title === "string" ? title : "Section"} actions`}>{actions}</ButtonGroup>}
      </header>
      {children}
    </section>
  );
}

export function SettingsCard({
  title,
  description,
  status,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-sm bg-panel p-6 max-md:p-4", className)}>
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <HelpLabel className="text-title" help={description}>{title}</HelpLabel>
          {status && <div className="mt-1 text-caption" role="status">{status}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center">{actions}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

/** A named region inside one settings surface. Directional hairlines separate
 * related regions without turning every group into another card. */
export function SettingsCardSection({
  title,
  description,
  status,
  icon: Icon,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border-t border-zinc-600/70 py-5 last:pb-0", className)}>
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <HelpLabel className="text-title" help={description}>
            {Icon && <Icon className="h-4 w-4 text-content-muted" aria-hidden="true" />}
            {title}
          </HelpLabel>
          {status && <div className="mt-1 text-caption" role="status">{status}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center">{actions}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </section>
  );
}
