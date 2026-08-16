/** A bot username is an address, not a label: it renders as `@name` inside
 *  message bodies and seeds the connector's account id, which lowercases the
 *  name and rewrites anything outside `[a-z0-9_-]` to `_`. Holding creation to
 *  that alphabet keeps the two in step instead of quietly producing a config
 *  whose account id no longer resembles the bot. The gateway enforces the same
 *  rule in `create_bot` — this copy is only so the dialog can say so first. */
export const BOT_USERNAME_MAX = 64;

const BOT_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** null when the name is acceptable, else a message that says how to fix it. */
export function botUsernameError(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Username is required.";
  if (value.length > BOT_USERNAME_MAX) {
    return `Username must be ${BOT_USERNAME_MAX} characters or fewer.`;
  }
  if (!BOT_USERNAME_PATTERN.test(value)) {
    return "Username can use letters, digits, hyphen and underscore, and must start with a letter or digit.";
  }
  return null;
}
