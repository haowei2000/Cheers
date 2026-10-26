import { useEffect, useState, type RefObject } from "react";

/** The nearest ancestor that scrolls vertically, else null (the viewport). */
export function scrollRootOf(el: Element): Element | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return node;
  }
  return null;
}

/**
 * Whether `ref` is within `rootMargin` of being visible. The observer is rooted at
 * the element's scroll container, since a margin on the implicit viewport root
 * never reaches content clipped by an inner overflow container (the chat list).
 * Without IntersectionObserver (tests, old engines) it is always near.
 */
export function useNearViewport(
  ref: RefObject<Element | null>,
  { rootMargin, enabled = true }: { rootMargin: string; enabled?: boolean },
): boolean {
  const supported = typeof IntersectionObserver !== "undefined";
  const [near, setNear] = useState(!supported);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !supported || !el) return;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { root: scrollRootOf(el), rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, rootMargin, enabled, supported]);
  return near;
}
