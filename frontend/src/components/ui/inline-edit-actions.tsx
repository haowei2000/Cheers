import { type ControlSize } from "./control-size";
import { ActionButton } from "./action-button";

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
  return (
    <span role="group" aria-label={`${label} editing actions`} className="inline-flex flex-shrink-0 items-center gap-1">
      {editing ? (
        <>
          <ActionButton
            action="cancel"
            context="inlineEdit"
            accessibleLabel={`Cancel editing ${label}`}
            controlSize={controlSize}
            disabled={saving}
            onClick={onCancel}
          />
          <ActionButton
            action="save"
            context="inlineEdit"
            accessibleLabel={`Save ${label}`}
            controlSize={controlSize}
            disabled={disabled || saving}
            loading={saving}
            onClick={onSave}
          />
        </>
      ) : (
        <ActionButton action="edit" context="inlineEdit" accessibleLabel={`Edit ${label}`} controlSize={controlSize} disabled={disabled} onClick={onEdit} />
      )}
    </span>
  );
}
