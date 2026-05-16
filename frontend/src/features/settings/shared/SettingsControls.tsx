import type { ReactNode } from "react";

export const inputCls =
  "an-input";

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="an-field">
      <label className="an-label">{label}</label>
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
      className="an-btn an-btn-primary"
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
      className="an-btn an-btn-danger an-btn-sm"
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
      className="an-back"
    >
      ← {label}
    </button>
  );
}
