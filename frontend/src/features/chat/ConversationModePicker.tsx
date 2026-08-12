import { Button as UiButton } from "@/components/ui/button";
import { controlIconClasses } from "@/components/ui/control-size";
import { MessageCircle, MessagesSquare } from "lucide-react";
import { cn } from "@/lib/cn";
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
    <div className="grid grid-cols-2 gap-2" role="group" aria-label="Conversation layout">
      {OPTIONS.map((option) => {
        const selected = value === option.value;
        const Icon = option.icon;
        return (
          <UiButton
            variant="plain"
            key={option.value}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            aria-label={`${option.title}: ${option.description}`}
            title={option.description}
            onClick={() => onChange(option.value)}
            controlSize="regular"
            className={cn(
 "min-w-0 justify-start text-left",
 selected
 ? "bg-zinc-700 text-zinc-100": "bg-zinc-950/40 text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200",
 )}
          >
            <Icon className={cn(controlIconClasses.regular, "shrink-0", selected ? "text-zinc-100" : "text-zinc-500")} />
            <span className="min-w-0 truncate">{option.title}</span>
          </UiButton>
        );
      })}
    </div>
  );
}
