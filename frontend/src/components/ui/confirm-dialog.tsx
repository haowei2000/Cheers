import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Dialog } from "./dialog";
import { Button } from "./button";
import type { ActionKey } from "./action-labels";

/**
 * The confirm step for a destructive action (DESIGN.md §2.15 + §7).
 *
 * Two rules it exists to keep. First, consequences are stated here, in the
 * body — §2.14 forbids hiding behind hover anything the user must read to act
 * correctly, and "this cannot be undone" is exactly that. Second, confirming is
 * a deliberate click: `window.confirm` makes its OK the reflexive Enter
 * default, whereas focus here lands on the dialog's own Close control, so Enter
 * dismisses.
 */
export function ConfirmDialog({
  title,
  confirmAction,
  confirmLabel,
  busy = false,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  /** Shared action identity for the confirming button — delete, revoke, disable… */
  confirmAction: ActionKey;
  /** Overrides the registry label where the action reads better in context. */
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  /** What is about to happen. Required — this is the last stop before it does. */
  children: ReactNode;
}) {
  return (
    <Dialog
      title={
        <span className="flex items-center gap-2 text-danger-400">
          <AlertTriangle className="h-4 w-4" />
          {title}
        </span>
      }
      onClose={onClose}
      maxWidth="max-w-sm"
    >
      <div className="space-y-2 text-regular text-content-secondary">{children}</div>
      <div className="flex justify-end gap-2 pt-1">
        <Button
          action="cancel"
          variant="secondary"
          controlSize="compact"
          disabled={busy}
          onClick={onClose}
        />
        <Button
          action={confirmAction}
          variant="danger"
          controlSize="compact"
          loading={busy}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
