export function LazyPanelFallback({ label = "加载中..." }: { label?: string }) {
  return (
    <div className="flex h-full min-h-24 items-center justify-center text-sm text-[var(--fg-3)]">
      {label}
    </div>
  );
}
