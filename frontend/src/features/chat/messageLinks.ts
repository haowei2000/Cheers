import { createContext } from "react";
import { parseLocator } from "./locator";
import { looksLikePath } from "./workspaceLink";

/** The channel owns navigation; renderers only classify and request a jump. */
export const LocatorOpenContext = createContext<((uri: string) => void) | null>(null);

export type MessageLinkTarget =
  | { kind: "external"; href: string }
  | { kind: "locator"; uri: string }
  | { kind: "file"; ref: string };

export function classifyMessageLink(raw: string): MessageLinkTarget | null {
  if (parseLocator(raw)) return { kind: "locator", uri: raw };
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
      return { kind: "external", href: raw };
    }
  } catch {
    // Relative Markdown targets may name a file in the sender Bot's workspace.
  }
  if (looksLikePath(raw) && !raw.startsWith("/") && !raw.split("/").includes("..")) {
    return { kind: "file", ref: raw };
  }
  return null;
}

export function canOpenLocator(uri: string): boolean {
  const locator = parseLocator(uri);
  return Boolean(locator && locator.kind !== "msg");
}
