import { LANGUAGE_OPTIONS, type AppLanguage } from "./catalog";
import { useLanguage } from "./LanguageProvider";

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { language, setLanguage } = useLanguage();

  return (
    <label className={compact ? "an-lang-switch compact" : "an-lang-switch"}>
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
