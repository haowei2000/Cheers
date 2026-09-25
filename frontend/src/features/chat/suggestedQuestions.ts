export type SuggestionSlotKind = "mention" | "file" | "panel";

export interface SuggestedQuestion {
  text: string;
  slots: Array<{ key: string; kind: SuggestionSlotKind }>;
}

export const SLOT_PATTERN = /\{\{(mention|file|panel):\s*([a-zA-Z0-9_./-]{1,64})\}\}/gi;

/** The server validates the same shape before persistence. Treat historic data as untrusted. */
export function parseSuggestedQuestions(value: unknown): SuggestedQuestion[] {
  const target = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).suggestions)
    ? (value as Record<string, unknown>).suggestions
    : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).questions)
    ? (value as Record<string, unknown>).questions
    : null;
  if (!Array.isArray(target)) return [];
  return target.slice(0, 3).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.text !== "string" || !item.text.trim() || item.text.length > 500) return [];
    const rawSlots = item.slots ?? item.slot ?? [];
    if (!Array.isArray(rawSlots) || rawSlots.length > 6) return [];
    const slots = rawSlots.flatMap((slot) => {
      if (!slot || typeof slot !== "object") return [];
      const s = slot as Record<string, unknown>;
      const key = typeof s.key === "string" ? s.key.trim() : "";
      const kind = typeof s.kind === "string" ? s.kind.trim().toLowerCase() : "";
      if (!key || !/^[a-zA-Z0-9_./-]{1,64}$/.test(key)) return [];
      if (kind !== "mention" && kind !== "file" && kind !== "panel") return [];
      return [{ key, kind: kind as SuggestionSlotKind }];
    });
    if (slots.length !== rawSlots.length || new Set(slots.map((s) => s.key)).size !== slots.length) return [];
    const markers = [...item.text.matchAll(SLOT_PATTERN)];
    if (item.text.split("{{").length - 1 !== markers.length) return [];
    if (
      markers.length !== slots.length ||
      slots.some((s) => !markers.some((m) => m[1].toLowerCase() === s.kind && m[2].trim() === s.key))
    ) {
      return [];
    }
    return [{ text: item.text, slots }];
  });
}

export function firstUnresolvedSlot(text: string): RegExpExecArray | null {
  SLOT_PATTERN.lastIndex = 0;
  const match = SLOT_PATTERN.exec(text);
  SLOT_PATTERN.lastIndex = 0;
  return match;
}

export function formatSuggestionDisplayText(text: string): string {
  return text.replace(SLOT_PATTERN, (_, kind: string) => `[${kind.toLowerCase()}]`);
}

export interface ActiveBotSuggestion {
  msgId: string;
  questions: SuggestedQuestion[];
}

export function findActiveBotSuggestions({
  messages,
  currentUserId,
  streamingIds = [],
}: {
  messages: Array<{
    msg_id: string;
    sender_id: string;
    sender_type: string;
    reply_to_msg_id?: string | null;
    content_data?: unknown;
    is_partial?: boolean;
    _streaming?: boolean;
  }>;
  currentUserId?: string | null;
  streamingIds?: string[];
}): ActiveBotSuggestion | null {
  if (!currentUserId || messages.length === 0) return null;

  // 1. If the latest message was authored by current user, the user is waiting for the bot or just sent a new message.
  const lastMsg = messages[messages.length - 1];
  if (lastMsg && lastMsg.sender_id === currentUserId) {
    return null;
  }

  // 2. Scan backwards through the current turn's bot messages.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    // If we encounter a user message before finding any bot message with suggestions,
    // we have passed the current bot turn without finding suggestions.
    if (msg.sender_type === "user") {
      return null;
    }

    if (msg.sender_type === "bot") {
      // If this bot message is currently streaming, suggestions are not ready.
      if (streamingIds.includes(msg.msg_id) || msg.is_partial || msg._streaming) {
        return null;
      }

      // Check if there are valid suggestions on this bot message
      const questions = parseSuggestedQuestions(
        (msg.content_data as Record<string, unknown> | null)?.suggested_questions
      );
      if (questions.length > 0) {
        // 3. Verify that this bot turn was triggered by currentUserId
        let isTriggeredByCurrentUser = false;

        if (msg.reply_to_msg_id) {
          const trigger = messages.find((m) => m.msg_id === msg.reply_to_msg_id);
          if (trigger && trigger.sender_id === currentUserId) {
            isTriggeredByCurrentUser = true;
          }
        } else {
          // Find the preceding user message before this bot message
          for (let j = i - 1; j >= 0; j--) {
            const prev = messages[j];
            if (prev.sender_type === "user") {
              if (prev.sender_id === currentUserId) {
                isTriggeredByCurrentUser = true;
              }
              break;
            }
          }
        }

        if (isTriggeredByCurrentUser) {
          return { msgId: msg.msg_id, questions };
        }

        // If this bot message was not triggered by current user, stop (do not leak another user's bot turn).
        return null;
      }
    }
  }

  return null;
}
