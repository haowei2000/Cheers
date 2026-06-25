import { AlertCircle } from "lucide-react";
import { Dialog } from "./dialog";

// The shared error popup. Use this (not an ad-hoc toast) whenever an action fails
// and the user needs a clear, dismissible explanation.
export function ErrorDialog({
  message,
  title = "打开失败",
  onClose,
}: {
  message: string;
  title?: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={
        <span className="flex items-center gap-1.5 text-red-400">
          <AlertCircle className="w-4 h-4" />
          {title}
        </span>
      }
      onClose={onClose}
      maxWidth="max-w-sm"
    >
      <p className="text-sm text-zinc-300 whitespace-pre-wrap break-words">{message}</p>
      <div className="flex justify-end pt-1">
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
        >
          知道了
        </button>
      </div>
    </Dialog>
  );
}
