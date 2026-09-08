import { useLayoutEffect, type RefObject } from "react";

/** Keep the first visible message at the same offset when the reading column
 * changes size. A hidden narrow-screen conversation keeps its last anchor. */
export function useReadingPosition(
  ref: RefObject<HTMLElement>,
  resetKey: unknown,
) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    let height = element.clientHeight;
    let anchor: HTMLElement | undefined;
    let offset = 0;
    let atBottom = true;
    let hidden = false;
    const capture = () => {
      if (!element.clientWidth || !element.clientHeight) return;
      // ResizeObserver restores the previous snapshot before scroll events can
      // replace it with the reflowed geometry.
      if (element.clientWidth !== width || element.clientHeight !== height)
        return;
      atBottom = element.scrollHeight - element.scrollTop - height < 80;
      const top = element.getBoundingClientRect().top;
      const rows = element.querySelectorAll<HTMLElement>("[data-msg-id]");
      // Row tops follow DOM order, including nested replies. Binary search avoids
      // measuring the entire history on every scroll event.
      let low = 0;
      let high = rows.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (rows[mid].getBoundingClientRect().top < top) low = mid + 1;
        else high = mid;
      }
      const previous = rows[Math.max(0, low - 1)];
      anchor =
        previous?.getBoundingClientRect().bottom > top ? previous : rows[low];
      offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
    };
    const observer = new ResizeObserver(() => {
      const nextWidth = element.clientWidth;
      const nextHeight = element.clientHeight;
      if (!nextWidth || !nextHeight) {
        hidden = true;
        return;
      }
      if (hidden || width !== nextWidth || height !== nextHeight) {
        if (atBottom) element.scrollTop = element.scrollHeight - nextHeight;
        else if (anchor?.isConnected)
          element.scrollTop +=
            anchor.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            offset;
        width = nextWidth;
        height = nextHeight;
        hidden = false;
      }
      capture();
    });
    capture();
    observer.observe(element);
    element.addEventListener("scroll", capture, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", capture);
    };
  }, [ref, resetKey]);
}
