import { Button as UiButton } from "@/components/ui/button";
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
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="group" aria-label="Conversation layout">
      {OPTIONS.map((option) => {
        const selected = value === option.value;
        const Icon = option.icon;
        return (
          <UiButton variant="plain"
            key={option.value}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            controlSize="comfortable" className={cn(
 " rounded-sm  px-3 text-left transition-colors",
 "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900",
 selected
 ? "border-indigo-500 bg-indigo-500/10 text-zinc-100"
 : "border-zinc-800 bg-zinc-950/40 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800/60",
 disabled && "cursor-not-allowed opacity-50",
 )}
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Icon className={cn("h-4 w-4", selected ? "text-indigo-300" : "text-zinc-500")} />
              {option.title}
            </span>
            <span className="mt-1 block text-xs leading-5 text-zinc-400">
              {option.description}
            </span>
          </UiButton>
        );
      })}
    </div>
  );
}
