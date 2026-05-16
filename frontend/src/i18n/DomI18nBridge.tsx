import { useEffect } from "react";
import { useLanguage } from "./LanguageProvider";
import { translateDom } from "./translateDom";

export function DomI18nBridge() {
  const { language } = useLanguage();

  useEffect(() => {
    let scheduled = false;
    const run = () => {
      scheduled = false;
      translateDom(document.body, language);
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      window.queueMicrotask(run);
    };

    schedule();
    if (language === "en") return;

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "title", "placeholder", "alt"],
    });
    return () => observer.disconnect();
  }, [language]);

  return null;
}
