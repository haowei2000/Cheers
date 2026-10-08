import { useAnnotationSurface } from "@/features/annotations/AnnotationProvider";
import { IconButton } from "@/components/ui/icon-button";
import { EditorialIcon } from "@/components/ui/editorial-icons";
import type { Annotation } from "./annotations";
import { resolveAnnotation } from "./annotations";

export interface AnnotationsButtonProps {
  notes: readonly Annotation[];
  allNotes?: readonly Annotation[];
  currentPath?: string;
  text?: string;
  onSelectAnnotation?: (id: string | null) => void;
  onReveal?: (range: { start: number; end: number }) => void;
  onSelectFile?: (path: string) => void;
}
/** Workbench entry to the same channel annotation surface used by trace events. */
export function AnnotationsButton({
  notes,
  allNotes,
  currentPath,
  text = "",
  onSelectAnnotation,
  onReveal,
  onSelectFile,
}: AnnotationsButtonProps) {
  const surface = useAnnotationSurface();
  if (!surface) return null;
  return (
    <IconButton
      label={`Annotations (${notes.length})`}
      onClick={() =>
        surface.open({
          target: currentPath
            ? { kind: "file", path: currentPath, anchor: { kind: "file" } }
            : undefined,
          label: currentPath,
          reveal: (item) => {
            if (item.target.kind !== "file") return;
            onSelectAnnotation?.(item.id);
            if (item.target.path !== currentPath)
              onSelectFile?.(item.target.path);
            const note =
              allNotes?.find((n) => n.id === item.id) ??
              notes.find((n) => n.id === item.id);
            if (note && item.target.path === currentPath) {
              const range = resolveAnnotation(note, text);
              if (range) onReveal?.(range);
            }
          },
        })
      }
      controlSize="comfortable"
    >
      <EditorialIcon name="annotation" />
    </IconButton>
  );
}
