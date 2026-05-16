import { AppIcon } from "./icons/AppIcon";

interface DragOverlayProps {
  visible: boolean;
  isDark: boolean;
}

export function DragOverlay({ visible, isDark }: DragOverlayProps) {
  if (!visible) return null;
  return (
    <>
      <style>{`
        @keyframes dropOverlayPulse {
          0%,100% { transform: translateY(0); opacity: 0.92; }
          50% { transform: translateY(4px); opacity: 1; }
        }
        .an-drag-overlay-mark {
          animation: dropOverlayPulse 1.6s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .an-drag-overlay-mark {
            animation: none;
          }
        }
      `}</style>
      <div
        className="absolute inset-0 z-50 flex flex-col items-center justify-center select-none pointer-events-none"
        style={{
          backdropFilter: "blur(10px)",
          backgroundColor: isDark
            ? "color-mix(in oklab, var(--bg-0) 78%, transparent)"
            : "color-mix(in oklab, var(--bg-0) 72%, transparent)",
        }}
      >
        <div
          className="an-drag-overlay-mark mb-5 grid h-16 w-16 place-items-center rounded-lg border border-[var(--border)] bg-[var(--bg-1)] shadow-xl"
          style={{ color: "var(--accent)" }}
        >
          <AppIcon name="upload" className="h-8 w-8" />
        </div>
        <div
          className="mb-3 text-center text-2xl font-semibold"
          style={{ color: "var(--fg-1)" }}
        >
          Drop files here
        </div>
        <p className="text-center text-sm leading-relaxed" style={{ color: "var(--fg-3)" }}>
          Images: PNG, JPG, JPEG, WEBP, GIF
          <br />
          Docs:PDF, TXT, MD, DOCX, XLSX
        </p>
      </div>
    </>
  );
}
