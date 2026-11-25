import { createContext, useContext, type AriaAttributes } from "react";

export const FieldContext = createContext<{
  labelId: string;
  htmlFor?: string;
  descriptionIds: string[];
  invalid: boolean;
} | null>(null);

type ControlAttributes = AriaAttributes & { id?: string };

/** Bind shared controls even when a field contains a composite or multiple inputs. */
export function useFieldControl<T extends ControlAttributes>(props: T): T {
  const field = useContext(FieldContext);
  if (!field) return props;
  const describedBy = [...new Set([
    ...(props["aria-describedby"]?.split(/\s+/).filter(Boolean) ?? []),
    ...field.descriptionIds,
  ])].join(" ") || undefined;
  return {
    ...props,
    id: props.id ?? field.htmlFor,
    "aria-labelledby": props["aria-labelledby"] ?? (props["aria-label"] ? undefined : field.labelId),
    "aria-describedby": describedBy,
    "aria-invalid": props["aria-invalid"] ?? (field.invalid || undefined),
  };
}
