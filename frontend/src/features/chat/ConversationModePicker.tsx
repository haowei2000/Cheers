/** @file Accessible two-option control for selecting chat or discussion layout. */

import { ChoiceGroup } from "@/components/ui/choice-button";
import { MessageCircle, MessagesSquare } from "lucide-react";
import type { ConversationMode } from "./conversationMode";

export type { ConversationMode } from "./conversationMode";

const OPTIONS: Array<{
  value: ConversationMode;
  title: string;
  description: string;
  icon: typeof MessageCircle;
}> = [
  {
    value: "chat",
    title: "Chat",
    description: "Chronological replies; your messages appear on the right.",
    icon: MessageCircle,
  },
  {
    value: "discuss",
    title: "Discuss",
    description: "Everyone stays left; replies remain grouped with the topic.",
    icon: MessagesSquare,
  },
];

/** Render the conversation-mode choices and report the selected mode. */
export function ConversationModePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: ConversationMode;
  onChange: (value: ConversationMode) => void;
  disabled?: boolean;
}) {
  return (
    <ChoiceGroup
      ariaLabel="Conversation layout"
      value={value}
      onChange={onChange}
      disabled={disabled}
      controlSize="regular"
      options={OPTIONS.map((option) => {
        const Icon = option.icon;
        return {
          value: option.value,
          label: option.title,
          description: option.description,
          leading: <Icon />,
        };
      })}
    />
  );
}
