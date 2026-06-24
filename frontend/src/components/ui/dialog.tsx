import type { ReactNode } from "react";
import { X } from "lucide-react";

// A centered modal shell: backdrop (click-to-close) + card (click-stop) + optional titled
// header with a close button. Reused by NewDmDialog, the bot-token modal, etc.
export function Dialog({
  title,
  onClose,
  children,
  maxWidth = "max-w-md",
}: {
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-24"
      onClick={onClose}
    >
      <div
        className={`w-full ${maxWidth} rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3`}
        onClick={(e) => e.stopPropagation()}
      >
        {title !== undefined && (
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-zinc-100">{title}</span>
            <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-300">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
