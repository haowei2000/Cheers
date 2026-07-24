import toast from "react-hot-toast";
import { AlertCircle, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import type { ComponentType } from "react";

// Tier S of the global error system: a thin semantic layer over react-hot-toast.
// Adds the severity icon and an optional ACTION (the exit — "Retry", "Reload"),
// which the stock toast.error string form can't carry. Prefer these over raw
// toast.* in new code; existing call sites migrate progressively.
//
// Durations: success is read-and-gone (3s); errors linger (6s), and an error
// with an action stays long enough to actually click it (10s).

type Severity = "error" | "warning" | "success" | "info";

interface NotifyOpts {
  /** At most one exit per toast; clicking it dismisses the toast. */
  action?: { label: string; onClick: () => void };
  /** Override the per-severity default (ms). */
  duration?: number;
}

const ICONS: Record<Severity, ComponentType<{ className?: string }>> = {
  error: AlertCircle,
  warning: TriangleAlert,
  success: CircleCheck,
  info: Info,
};

const ICON_CLS: Record<Severity, string> = {
  error: "text-red-400",
  warning: "text-amber-400",
  success: "text-emerald-400",
  info: "text-indigo-400",
};

const DURATION: Record<Severity, number> = {
  error: 6000,
  warning: 6000,
  success: 3000,
  info: 5000,
};

function show(severity: Severity, message: string, opts?: NotifyOpts): string {
  const Icon = ICONS[severity];
  const duration =
    opts?.duration ??
    (opts?.action && severity !== "success" ? 10000 : DURATION[severity]);
  return toast.custom(
    (t) => (
      <div
        role={severity === "error" ? "alert" : "status"}
        className={`pointer-events-auto flex max-w-xs items-start gap-2.5 rounded-xl bg-zinc-900 px-3 py-2.5 shadow-xl shadow-black/40 transition-all duration-150 ${
          t.visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"
        }`}
      >
        <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${ICON_CLS[severity]}`} />
        <div className="min-w-0 text-sm text-zinc-200">
          <span className="break-words">{message}</span>
          {opts?.action && (
            <div className="mt-1">
              <button
                type="button"
                onClick={() => {
                  toast.dismiss(t.id);
                  opts.action!.onClick();
                }}
                className="text-xs font-semibold text-indigo-400 hover:text-indigo-300 hover:underline"
              >
                {opts.action.label}
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => toast.dismiss(t.id)}
          aria-label="Dismiss"
          className="mt-0.5 flex-shrink-0 text-zinc-500 transition-colors hover:text-zinc-300"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    ),
    { duration }
  );
}

export const notify = {
  error: (message: string, opts?: NotifyOpts) => show("error", message, opts),
  warning: (message: string, opts?: NotifyOpts) => show("warning", message, opts),
  success: (message: string, opts?: NotifyOpts) => show("success", message, opts),
  info: (message: string, opts?: NotifyOpts) => show("info", message, opts),
};

/** The human message of an unknown thrown value. Unlike `String(e)`, never
 *  yields "Error: …" / "[object Object]" — the api client already humanizes
 *  ApiError messages, so `e.message` is the renderable sentence. */
export function messageOf(e: unknown, fallback = "Something went wrong"): string {
  if (e instanceof Error) {
    const msg = e.message?.trim();
    // Legacy gateway unique-violation bodies were literally "conflict".
    if (msg && msg.toLowerCase() !== "conflict") return msg;
    if (
      "status" in e &&
      typeof (e as { status?: unknown }).status === "number" &&
      (e as { status: number }).status === 409
    ) {
      return "That name is already taken — choose another, or use Existing bot";
    }
    return msg || fallback;
  }
  if (typeof e === "string" && e.trim()) {
    const msg = e.trim();
    if (msg.toLowerCase() === "conflict") {
      return "That name is already taken — choose another, or use Existing bot";
    }
    return msg;
  }
  return fallback;
}
