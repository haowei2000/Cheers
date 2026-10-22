import { listMessages } from "@/api/messages";
import type { Message } from "@/types";
import { needsClaimReconciliation } from "./taskClaimProjection";

/** Refresh only loaded, mutable claim cards using existing authenticated history reads. */
export async function reconcileClaimConfirmations(
  channelId: string,
  messages: Message[],
  current: () => boolean,
  apply: (message: Message) => void,
  read: typeof listMessages = listMessages,
): Promise<void> {
  const pending = [...new Map(messages.filter(needsClaimReconciliation).map((message) => [message.msg_id, message])).values()];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
    while (current() && cursor < pending.length) {
      const message = pending[cursor++];
      try {
        const response = await read(channelId, { since_seq: message.channel_seq! - 1, limit: 1 });
        if (!current()) return;
        const updated = (response.messages ?? response.data ?? []).find((row) => row.msg_id === message.msg_id);
        // Empty/different rows can mean visibility filtering, not deletion.
        if (updated) apply(updated);
      } catch {
        // Revoked membership and removed history must not erase a cached row.
      }
    }
  }));
}
