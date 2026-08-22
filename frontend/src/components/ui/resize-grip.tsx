import { MoveDiagonal2 } from "lucide-react";
import type { WindowDrag } from "@/hooks/useWindowDrag";

// Bottom-right resize grip for the floating windows (spread `resizeProps` from
// useWindowDrag). Desktop-only — mobile windows are full-screen sheets.
export function ResizeGrip({ resizeProps }: { resizeProps: WindowDrag["resizeProps"] }) {
  return (
    <div
      {...resizeProps}
      title="Resize"
      className="absolute bottom-0 right-0 z-10 flex h-7 w-7 cursor-se-resize items-end justify-end p-1 text-content-subtle transition-colors hover:text-content-secondary select-none max-md:hidden"
    >
      <MoveDiagonal2 className="h-3.5 w-3.5" aria-hidden="true" />
    </div>
  );
}
