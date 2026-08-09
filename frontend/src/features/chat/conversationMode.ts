import type { Message } from "@/types";
import { groupMessagesByReply, isFoldedPermission } from "./messageTree";

export type ConversationMode = "chat" | "discuss";

/** Build the shared reply index once, then choose which messages are top-level.
 * Chat preserves server chronology; Discuss exposes only roots and lets the UI
 * recurse through `childrenByParent`. */
export function layoutMessages(messages: Message[], mode: ConversationMode) {
  const tree = groupMessagesByReply(messages);
  return {
    ...tree,
    topLevel:
      mode === "discuss"
        ? tree.roots
        : messages.filter((message) => !isFoldedPermission(message)),
  };
}
