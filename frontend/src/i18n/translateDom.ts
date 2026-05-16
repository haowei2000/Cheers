import { LANGUAGE_BY_CODE, translateToChinese, type AppLanguage } from "./catalog";

type TranslationCache = Map<string, Promise<string | null>>;

const textOriginals = new WeakMap<Text, string>();
const attrOriginals = new WeakMap<Element, Record<string, string>>();
const autoCache: TranslationCache = new Map();

const TRANSLATABLE_ATTRS = ["aria-label", "title", "placeholder", "alt"];
const SKIP_TEXT_SELECTOR = [
  "script",
  "style",
  "code",
  "pre",
  "textarea",
  "input",
  "select",
  "option",
  "[contenteditable='true']",
  "[data-i18n-skip]",
  "[id^='msg-'] .an-message-clamp-window",
  "[id^='msg-'] .whitespace-pre-wrap",
  ".an-search-result-snippet",
].join(",");

type BrowserTranslator = {
  translate: (text: string) => Promise<string>;
  destroy?: () => void;
};

declare global {
  interface Window {
    Translator?: {
      create: (options: { sourceLanguage: string; targetLanguage: string }) => Promise<BrowserTranslator>;
    };
    translation?: {
      createTranslator?: (options: { sourceLanguage: string; targetLanguage: string }) => Promise<BrowserTranslator>;
    };
  }
}

export function translateDom(root: ParentNode, language: AppLanguage): void {
  const option = LANGUAGE_BY_CODE.get(language);
  if (!option || language === "en") {
    restoreDom(root);
    return;
  }

  const target = option.targetLanguage;
  walkTextNodes(root, (node) => translateTextNode(node, target));
  translateAttributes(root, target);
}

function walkTextNodes(root: ParentNode, visit: (node: Text) => void): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest(SKIP_TEXT_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let current = walker.nextNode();
  while (current) {
    visit(current as Text);
    current = walker.nextNode();
  }
}

function translateTextNode(node: Text, targetLanguage: string): void {
  const current = node.nodeValue ?? "";
  let original = textOriginals.get(node);
  if (original === undefined) {
    original = current;
    textOriginals.set(node, original);
  } else {
    const translated = translateFromEnglish(original, targetLanguage);
    if (current !== original && current !== translated && targetLanguage === "zh-CN") {
      original = current;
      textOriginals.set(node, original);
    }
  }

  const translated = translateFromEnglish(original, targetLanguage);
  if (targetLanguage === "zh-CN") {
    if (node.nodeValue !== translated) node.nodeValue = translated;
    return;
  }

  if (node.nodeValue !== original) node.nodeValue = original;
  void translateAutomatically(original, targetLanguage).then((translated) => {
    if (translated && textOriginals.get(node) === original) {
      node.nodeValue = translated;
    }
  });
}

function translateAttributes(root: ParentNode, targetLanguage: string): void {
  const elements =
    root instanceof Element
      ? [root, ...Array.from(root.querySelectorAll("*"))]
      : Array.from(root.querySelectorAll("*"));
  for (const element of elements) {
    if (element.closest("[data-i18n-skip]")) continue;
    const originals = attrOriginals.get(element) ?? {};
    let touched = false;
    for (const attr of TRANSLATABLE_ATTRS) {
      const current = element.getAttribute(attr);
      if (!current?.trim()) continue;
      let original = originals[attr] ?? current;
      const translated = translateFromEnglish(original, targetLanguage);
      if (targetLanguage === "zh-CN" && current !== original && current !== translated) {
        original = current;
      }
      originals[attr] = original;
      const nextValue = translateFromEnglish(original, targetLanguage);
      if (element.getAttribute(attr) !== nextValue) element.setAttribute(attr, nextValue);
      if (targetLanguage !== "zh-CN") {
        void translateAutomatically(original, targetLanguage).then((translated) => {
          if (translated && attrOriginals.get(element)?.[attr] === original) {
            element.setAttribute(attr, translated);
          }
        });
      }
      touched = true;
    }
    if (touched) attrOriginals.set(element, originals);
  }
}

function translateFromEnglish(value: string, targetLanguage: string): string {
  if (targetLanguage === "zh-CN") return translateToChinese(value);
  return value;
}

function restoreDom(root: ParentNode): void {
  walkTextNodes(root, (node) => {
    const original = textOriginals.get(node);
    if (original === undefined) return;
    const current = node.nodeValue ?? "";
    if (current !== original) node.nodeValue = original;
  });

  const elements =
    root instanceof Element
      ? [root, ...Array.from(root.querySelectorAll("*"))]
      : Array.from(root.querySelectorAll("*"));
  for (const element of elements) {
    const originals = attrOriginals.get(element);
    if (!originals) continue;
    for (const [attr, value] of Object.entries(originals)) {
      const current = element.getAttribute(attr);
      if (current !== value) element.setAttribute(attr, value);
    }
  }
}

async function translateAutomatically(text: string, targetLanguage: string): Promise<string | null> {
  if (!text.trim() || targetLanguage === "en" || targetLanguage === "zh-CN") return null;
  const key = `${targetLanguage}\u0000${text}`;
  const cached = autoCache.get(key);
  if (cached) return cached;
  const next = translateWithBrowserApi(text, targetLanguage).catch(() => null);
  autoCache.set(key, next);
  return next;
}

async function translateWithBrowserApi(text: string, targetLanguage: string): Promise<string | null> {
  const factory =
    window.Translator?.create ??
    window.translation?.createTranslator;
  if (!factory) return null;
  const translator = await factory({ sourceLanguage: "en", targetLanguage });
  try {
    return await translator.translate(text);
  } finally {
    translator.destroy?.();
  }
}
