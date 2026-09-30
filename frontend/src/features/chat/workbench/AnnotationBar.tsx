/**
 * Annotation UI components for Cheers Workbench.
 *
 * Decomposed into:
 * - AnnotationComposer.tsx: Anchored modal note composer with focus trapping
 * - AnnotationsButton.tsx: Action-corner popover trigger and annotation list
 *
 * Re-exported here for complete backward compatibility.
 */

export {
  AnnotationComposer,
  anchorOfTarget,
  type AnnotationComposerProps,
  type PendingAnnotation,
} from "./AnnotationComposer";

export {
  AnnotationsButton,
  AnnotationListContent,
  formatNoteDate,
  type AnnotationsButtonProps,
  type AnnotationListContentProps,
} from "./AnnotationsButton";
