import type { DeclaredAction, PresentationLevel } from "./types.ts";

const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function extractTsxActions(content: string): DeclaredAction[] {
  const marker = "@cheers-actions";
  const idx = content.indexOf(marker);
  if (idx === -1) return [];

  const rest = content.slice(idx + marker.length);
  const commentEnd = rest.indexOf("*/");
  const block = commentEnd !== -1 ? rest.slice(0, commentEnd) : rest;

  // Strip leading whitespace and optional '*' on each line (JSDoc block comments)
  const cleaned = block
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith("*") ? trimmed.slice(1).trim() : trimmed;
    })
    .join("\n");

  const start = cleaned.search(/[[{]/);
  if (start === -1) return [];

  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start));
    const items: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && "actions" in parsed && Array.isArray((parsed as { actions: unknown }).actions)
        ? (parsed as { actions: unknown[] }).actions
        : parsed && typeof parsed === "object"
          ? [parsed]
          : [];

    const actions: DeclaredAction[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const raw = item as Record<string, unknown>;
      const actionId = typeof raw.actionId === "string" ? raw.actionId : "";
      if (!ACTION_ID.test(actionId)) continue;

      const rawName = typeof raw.name === "string" ? raw.name : typeof raw.type === "string" ? raw.type : "";
      let name: DeclaredAction["name"];
      if (rawName === "request" || rawName === "cheers.request") name = "cheers.request";
      else if (rawName === "compose" || rawName === "cheers.compose") name = "cheers.compose";
      else if (rawName === "open" || rawName === "cheers.open") name = "cheers.open";
      else if (rawName === "openNative" || rawName === "cheers.openNative") name = "cheers.openNative";
      else continue;

      const botId = typeof raw.botId === "string" && UUID.test(raw.botId) ? raw.botId : undefined;
      if (name === "cheers.request" && !botId) continue;

      const uri = typeof raw.uri === "string" ? raw.uri : undefined;
      const opener = typeof raw.opener === "string" ? raw.opener : undefined;
      const payload = raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
        ? (raw.payload as Record<string, unknown>)
        : {};
      const presentation: PresentationLevel[] = Array.isArray(raw.presentation)
        ? raw.presentation.filter((p): p is PresentationLevel => p === "minimal" || p === "medium" || p === "max")
        : ["minimal", "medium", "max"];
      const version = typeof raw.version === "number" && raw.version >= 1 ? raw.version : 1;

      actions.push({ actionId, name, botId, uri, opener, payload, presentation, version });
    }
    return actions;
  } catch {
    return [];
  }
}
