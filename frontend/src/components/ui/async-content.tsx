import type { ReactNode } from "react";
import { ErrorState } from "./error-state";
import { SurfaceSpinner } from "./spinner";

/** A failed load must never fall through to an empty/success state. */
export function AsyncContent({ loading, error, onRetry, children }: {
  loading: boolean;
  error?: string | null;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (loading) return <SurfaceSpinner />;
  if (error) return <ErrorState title="Couldn't load this section" description={error} action={{ label: "Retry", onClick: onRetry }} />;
  return <>{children}</>;
}
