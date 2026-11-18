/** @file Spot a pasted session reference from another app in the composer draft. */

// Detection only offers the attach banner; the gateway's shared parser
// (bridge-protocol `session_ref`) decides what the reference really is.
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const PATTERNS: Array<{ app: string; pattern: RegExp }> = [
  { app: "Codex thread", pattern: new RegExp(`codex://threads/${UUID}`) },
  { app: "Codex thread", pattern: new RegExp(`\\bcodex resume ${UUID}`) },
  { app: "Claude Code session", pattern: new RegExp(`\\bclaude (?:--resume|-r) ${UUID}`) },
];

export interface SessionReference {
  /** The exact substring to send to the gateway. */
  raw: string;
  /** Human name of what it points at, e.g. "Codex thread". */
  app: string;
}

export function findSessionReference(text: string): SessionReference | null {
  for (const { app, pattern } of PATTERNS) {
    const match = pattern.exec(text);
    if (match) return { raw: match[0], app };
  }
  return null;
}
