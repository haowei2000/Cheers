import { Button as UiButton } from "@/components/ui/button";
import { Pin } from "lucide-react";

// Pin a file's content into every bot prompt (the semantic layer). Shared by the File
// panel and lens views so the toggle looks/behaves identically everywhere.
export function PinToggle({
  path,
  pinned,
  togglePin,
}: {
  path: string;
  pinned: string[];
  togglePin: (path: string) => void;
}) {
  const isPinned = pinned.includes(path);
  return (
    <UiButton action={isPinned ? "unpin" : "pin"} variant="plain"
      onClick={() => togglePin(path)}
      title={isPinned ? "Pinned: injected into every prompt — click to unpin" : "Pin: inject this file's content into every bot prompt"}
    >
      <Pin
        className={`w-3.5 h-3.5 ${
          isPinned ? "fill-amber-400 text-warning-400" : "text-content-muted hover:text-content-secondary"
        }`}
      />
    </UiButton>
  );
}
