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
