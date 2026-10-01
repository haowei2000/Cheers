/** A stable file anchor shared by annotations and workspace renderers. */
export type AnnotationAnchor =
  | { kind: "uri"; uri: string }
  | { kind: "path"; sourcePath: ReadonlyArray<string | number> }
  | { kind: "text"; sourceText: string }
  | { kind: "file" };
