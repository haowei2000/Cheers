import { Component, type ErrorInfo, type ReactNode } from "react";
import toast from "react-hot-toast";
import { ErrorState } from "@/components/ui/error-state";

// Top-level render-crash net (tier L of the global error system). Without it a
// single render throw blanks the whole app; with it the user gets a Reload exit
// and can hand us the stack. Mounted once in main.tsx around <App />.
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The one deliberate console.error in the app: a crash here has no other
    // sink, and the stack is what makes a bug report actionable.
    console.error("Unhandled render error:", error, info.componentStack);
  }

  copyDetails = () => {
    const err = this.state.error;
    const details = `${err?.name ?? "Error"}: ${err?.message ?? "unknown"}\n${err?.stack ?? ""}`;
    navigator.clipboard
      .writeText(details)
      .then(() => toast.success("Error details copied"))
      .catch(() => toast.error("Couldn't copy — see the browser console"));
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <ErrorState
          title="Something broke on our side"
          description="The app hit an unexpected error. Reloading usually fixes it."
          action={{ label: "Reload", onClick: () => window.location.reload() }}
          secondaryAction={{ label: "Copy error details", onClick: this.copyDetails }}
        />
      </div>
    );
  }
}
