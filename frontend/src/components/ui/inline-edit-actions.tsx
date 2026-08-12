import { Check, Loader2, Pencil, X } from "lucide-react";
import { controlIconClasses, type ControlSize } from "./control-size";
import { IconButton } from "./icon-button";

export function InlineEditActions({
  label,
  editing,
  saving = false,
  disabled = false,
  controlSize = "compact",
  onEdit,
  onSave,
  onCancel,
}: {
  label: string;
  editing: boolean;
  saving?: boolean;
  disabled?: boolean;
  controlSize?: ControlSize;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const iconClass = controlIconClasses[controlSize];
  return (
    <span role="group" aria-label={`${label} editing actions`} className="inline-flex flex-shrink-0 items-center gap-1">
      {editing ? (
        <>
          <IconButton
            label={`Cancel editing ${label}`}
            controlSize={controlSize}
            disabled={saving}
            onClick={onCancel}
          >
            <X className={iconClass} />
          </IconButton>
          <IconButton
            label={`Save ${label}`}
            tone="success"
            controlSize={controlSize}
            disabled={disabled || saving}
            aria-busy={saving || undefined}
            onClick={onSave}
          >
            {saving ? <Loader2 className={`${iconClass} animate-spin`} /> : <Check className={iconClass} />}
          </IconButton>
        </>
      ) : (
        <IconButton label={`Edit ${label}`} controlSize={controlSize} disabled={disabled} onClick={onEdit}>
          <Pencil className={iconClass} />
        </IconButton>
      )}
    </span>
  );
}
