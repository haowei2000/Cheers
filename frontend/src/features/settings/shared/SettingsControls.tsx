import type { ReactNode } from "react";

export const inputCls =
  "w-full px-3 py-2 border border-[var(--border)] rounded-lg text-sm bg-[var(--bg-0)] text-[var(--fg-1)] focus:outline-none focus:border-[var(--accent)]";

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label
        style={{
          display: "block",
          fontSize: 11,
          fontWeight: 600,
          color: "var(--fg-2)",
          marginBottom: 4,
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

export function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "8px 16px",
        background: "var(--accent)",
        color: "#fff",
        border: 0,
        borderRadius: 6,
        fontSize: 13,
        fontWeight: 500,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}

export function DangerButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "6px 12px",
        background: "transparent",
        color: "var(--red)",
        border: "1px solid var(--red)",
        borderRadius: 6,
        fontSize: 12,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}

export function BackBar({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      style={{
        alignItems: "center",
        alignSelf: "flex-start",
        background: "transparent",
        border: 0,
        color: "var(--fg-3)",
        cursor: "pointer",
        display: "inline-flex",
        fontFamily: "inherit",
        fontSize: 12,
        gap: 6,
        padding: "4px 2px",
      }}
    >
      ← {label}
    </button>
  );
}
