import { AlertCircle } from "lucide-react";
import { Dialog } from "./dialog";
import { Button } from "./button";

// The shared error popup for BLOCKING failures — when the user must read and
// acknowledge before continuing (e.g. their message was rejected). Routine
// operation failures use `toast.error` instead; that is the app-wide default.
// Pass `action` when there is a concrete next step (edit, retry, open settings):
// it becomes the primary button, with Cancel as the quiet exit.
export function ErrorDialog({
  message,
  title = "Something went wrong",
  action,
  onClose,
}: {
  message: string;
  title?: string;
  action?: { label: string; onClick: () => void };
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
      <div className="flex justify-end gap-2 pt-1">
        {action ? (
          <>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                onClose();
                action.onClick();
              }}
            >
              {action.label}
            </Button>
          </>
        ) : (
          <Button variant="secondary" size="sm" onClick={onClose}>
            Got it
          </Button>
        )}
      </div>
    </Dialog>
  );
}
