import { parseDocument, type Node } from "yaml";

export interface SourceLineRange {
  start: number;
  end: number;
}

function offsetRange(content: string, startOffset: number, endOffset: number): SourceLineRange {
  const start = content.slice(0, startOffset).split("\n").length;
  const end = start + content.slice(startOffset, endOffset).replace(/\n$/, "").split("\n").length - 1;
  return { start, end };
}

/** Resolve a renderer-supplied exact source anchor. Ambiguous anchors fail closed. */
export function uniqueSourceTextRange(content: string, sourceText: string): SourceLineRange | null {
  const normalized = content.replace(/\r\n/g, "\n");
  const anchor = sourceText.replace(/\r\n/g, "\n");
  if (!anchor.trim()) return null;
  const first = normalized.indexOf(anchor);
  if (first < 0 || normalized.indexOf(anchor, first + 1) >= 0) return null;
  return offsetRange(normalized, first, first + anchor.length);
}

/** A code-authored card keeps its identity when surrounding JSX/HTML is edited.
 * Duplicate ids are ambiguous and deliberately do not resolve. */
export function inspectableIdLineRange(content: string, id: string): SourceLineRange | null {
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) return null;
  const pattern = /\bdata-cheers-id\s*=\s*(["'])([^"']+)\1/g;
  let match: RegExpExecArray | null;
  let found: SourceLineRange | null = null;
  while ((match = pattern.exec(content)) !== null) {
    if (match[2] !== id) continue;
    if (found) return null;
    found = offsetRange(content, match.index, match.index + match[0].length);
  }
  return found;
}

/** Resolve a built-in lens target through the YAML AST. JSON is a YAML 1.2 subset. */
export function sourcePathLineRange(
  content: string,
  path: ReadonlyArray<string | number>,
): SourceLineRange | null {
  try {
    const document = parseDocument(content);
    const node = document.getIn(path, true) as Node | undefined;
    const range = node?.range;
    if (!range) return null;
    return offsetRange(content.replace(/\r\n/g, "\n"), range[0], range[1]);
  } catch {
    return null;
  }
}
