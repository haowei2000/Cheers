import type { WindowDrag } from "@/hooks/useWindowDrag";

// Bottom-right resize grip for the floating windows (spread `resizeProps` from
// useWindowDrag). Desktop-only — mobile windows are full-screen sheets.
export function ResizeGrip({ resizeProps }: { resizeProps: WindowDrag["resizeProps"] }) {
  return (
    <div
      {...resizeProps}
      title="Resize"
      className="absolute bottom-0 right-0 z-10 flex h-4 w-4 cursor-se-resize items-end justify-end p-0.5 text-zinc-600 hover:text-zinc-300 select-none max-md:hidden"
    >
      <svg viewBox="0 0 8 8" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.2">
        <path d="M1 7 L7 1 M4.5 7 L7 4.5" />
      </svg>
    </div>
  );
}
