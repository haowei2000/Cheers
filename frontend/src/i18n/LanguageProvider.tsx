import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_BY_CODE,
  LANGUAGE_OPTIONS,
  LANGUAGE_STORAGE_KEY,
  normalizeLanguage,
  type AppLanguage,
} from "./catalog";

type LanguageContextValue = {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  targetLanguage: string;
  isChinese: boolean;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<AppLanguage>(() => {
    if (typeof localStorage === "undefined") return DEFAULT_LANGUAGE;
    return normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY));
  });

  const setLanguage = useCallback((nextLanguage: AppLanguage) => {
    const normalized = normalizeLanguage(nextLanguage);
    setLanguageState(normalized);
    localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized);
  }, []);

  useEffect(() => {
    document.documentElement.lang = LANGUAGE_BY_CODE.get(language)?.targetLanguage || "en";
    document.documentElement.dataset.appLanguage = language;
  }, [language]);

  const value = useMemo<LanguageContextValue>(() => {
    const option = LANGUAGE_BY_CODE.get(language) ?? LANGUAGE_OPTIONS[0];
    return {
      language,
      setLanguage,
      targetLanguage: option.targetLanguage,
      isChinese: language === "zh-CN",
    };
  }, [language, setLanguage]);

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used inside LanguageProvider");
  }
  return context;
}
