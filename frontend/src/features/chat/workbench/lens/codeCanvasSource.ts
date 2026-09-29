import { validInspectableId } from "../../locator";

const ID_ATTRIBUTE = /\bdata-cheers-id\s*=\s*(["'])([^"']+)\1/g;
const POSITION_ATTRIBUTE = /^(\s+data-cheers-position\s*=\s*)(["'])(-?\d+),(-?\d+)\2/;
const MAX_COORDINATE = 100_000;

/** Change only the explicit position literal next to a unique card id.
 * Complex JSX expressions and ambiguous markup deliberately remain Raw-only. */
export function moveCodeCanvasCard(source: string, id: string, x: number, y: number): string | null {
  if (!validInspectableId(id) || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)
    || Math.abs(x) > MAX_COORDINATE || Math.abs(y) > MAX_COORDINATE) return null;

  let found: { start: number; end: number; replacement: string } | null = null;
  for (const match of source.matchAll(ID_ATTRIBUTE)) {
    if (match[2] !== id || match.index === undefined) continue;
    if (found) return null;
    const afterId = match.index + match[0].length;
    const beforeId = source.slice(0, match.index);
    // The attribute must be inside an opening tag, not in prose or a string literal.
    if (beforeId.lastIndexOf("<") <= beforeId.lastIndexOf(">")) return null;
    const position = source.slice(afterId).match(POSITION_ATTRIBUTE);
    if (!position) return null;
    const start = afterId + position[1].length + 1;
    const end = start + position[3].length + 1 + position[4].length;
    found = { start, end, replacement: `${x},${y}` };
  }
  return found ? source.slice(0, found.start) + found.replacement + source.slice(found.end) : null;
}
