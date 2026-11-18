import type { ComponentType, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { RouteChromeHeader } from "@/features/desktop/RouteChromeHeader";
import { ActionButton } from "./action-button";
import { HelpLabel } from "./help-text";
import { contentIconClasses } from "./content-size";

/** Route pages share one header, navigation boundary, content width and scroll owner. */
export function PageLayout({ title, description, icon: Icon, actions, navigation, onBack, children }: {
  title: string;
  description?: ReactNode;
  icon: ComponentType<{ className?: string }>;
  actions?: ReactNode;
  navigation?: ReactNode;
  onBack?: () => void;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-canvas text-content-primary">
      <RouteChromeHeader actions={actions}>
        <header className="mx-auto flex w-full max-w-5xl items-center gap-4 px-6 py-5 max-md:px-4">
          <ActionButton action="back" context="windowChrome" accessibleLabel="Back to chat" onClick={onBack ?? (() => navigate("/chat"))} />
          <Icon className={`${contentIconClasses.regular} shrink-0 text-content-primary`} />
          <h1 className="min-w-0 flex-1 font-display text-regular font-semibold text-content-strong">
            <HelpLabel help={description}>{title}</HelpLabel>
          </h1>
          {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      </RouteChromeHeader>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6 max-md:p-4 max-md:pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:flex-row">
        {navigation}
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
