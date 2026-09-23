export type SuggestionSlotKind = "mention" | "file" | "panel";

export interface SuggestedQuestion {
  text: string;
  slots: Array<{ key: string; kind: SuggestionSlotKind }>;
}

export const SLOT_PATTERN = /\{\{(mention|file|panel):([a-z][a-z0-9_]{0,31})\}\}/g;

/** The server validates the same shape before persistence. Treat historic data as untrusted. */
export function parseSuggestedQuestions(value: unknown): SuggestedQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.text !== "string" || !item.text.trim() || item.text.length > 500) return [];
    if (!Array.isArray(item.slots) || item.slots.length > 6) return [];
    const slots = item.slots.flatMap((slot) => {
      if (!slot || typeof slot !== "object") return [];
      const s = slot as Record<string, unknown>;
      if (typeof s.key !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(s.key)) return [];
      if (s.kind !== "mention" && s.kind !== "file" && s.kind !== "panel") return [];
      return [{ key: s.key, kind: s.kind as SuggestionSlotKind }];
    });
    if (slots.length !== item.slots.length || new Set(slots.map((s) => s.key)).size !== slots.length) return [];
    const markers = [...item.text.matchAll(SLOT_PATTERN)];
    if (item.text.split("{{").length - 1 !== markers.length) return [];
    if (markers.length !== slots.length || slots.some((s) => !markers.some((m) => m[1] === s.kind && m[2] === s.key))) return [];
    return [{ text: item.text, slots }];
  });
}

export function firstUnresolvedSlot(text: string): RegExpExecArray | null {
  SLOT_PATTERN.lastIndex = 0;
  const match = SLOT_PATTERN.exec(text);
  SLOT_PATTERN.lastIndex = 0;
  return match;
}
