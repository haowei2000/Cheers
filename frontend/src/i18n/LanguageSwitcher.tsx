import { LANGUAGE_OPTIONS, type AppLanguage } from "./catalog";
import { useLanguage } from "./LanguageProvider";

export function LanguageSwitcher({
  compact = false,
  hideLabel = false,
}: {
  compact?: boolean;
  hideLabel?: boolean;
}) {
  const { language, setLanguage } = useLanguage();
  const className = [
    "an-lang-switch",
    compact ? "compact" : "",
    hideLabel ? "hide-label" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <label className={className}>
      <span className="an-lang-label">Language</span>
      <select
        value={language}
        onChange={(event) => setLanguage(event.target.value as AppLanguage)}
        aria-label="Language"
      >
        {LANGUAGE_OPTIONS.map((option) => (
          <option key={option.code} value={option.code}>
            {option.mode === "auto"
              ? `${option.nativeLabel} · Auto`
              : option.nativeLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
