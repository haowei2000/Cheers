import type { Message } from "@/types";
import { AuthRequiredCard } from "./AuthRequiredCard";
import { ElicitationCard } from "./ElicitationCard";

interface Props {
  message: Message;
  channelId?: string;
  currentUserId?: string;
}

/**
 * Unified Web boundary for Agent-initiated interaction cards. The source
 * protocol remains explicit: ACP elicitation and runtime diagnostics keep
 * their own DTOs and resolution endpoints behind this shared presentation seam.
 */
export function AgentInteractionCard({ message, channelId, currentUserId }: Props) {
  if (message.msg_type === "elicitation") {
    return <ElicitationCard message={message} channelId={channelId} currentUserId={currentUserId} />;
  }
  return <AuthRequiredCard message={message} channelId={channelId} currentUserId={currentUserId} />;
}
