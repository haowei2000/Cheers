import type { KeyboardEvent } from "react";

/**
 * True while an IME (pinyin, kana, hangul…) is mid-composition, i.e. the
 * candidate popup owns the keystroke. Enter there means "pick this word" and
 * Arrow/Escape navigate the popup — a handler that acts on them instead
 * commits the raw pinyin. `keyCode === 229` is the pre-`isComposing` signal
 * some browsers still emit.
 */
export function isComposing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}
