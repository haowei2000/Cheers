import type { ReactNode } from "react";
import type { ConversationMode } from "./conversationMode";

export function ConversationViewport({
  conversationMode,
  children,
}: {
  conversationMode: ConversationMode;
  children: ReactNode;
}) {
  return (
    <div
      data-channel-conversation=""
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div
        data-message-scroll-boundary=""
        className={`flex h-full min-h-0 w-full min-w-0 flex-col ${
          conversationMode === "discuss" ? "" : "md:mx-auto md:max-w-[52rem]"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
