import { useCallback, useRef, useState } from "react";

export function useResize(
  initialWidth: number,
  min: number,
  max: number,
  direction: "right" | "left" = "right",
) {
  const [width, setWidth] = useState(initialWidth);
  const widthRef = useRef(initialWidth);
  widthRef.current = width;
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = widthRef.current;
      const onMove = (ev: MouseEvent) => {
        const delta =
          direction === "right" ? ev.clientX - startX : startX - ev.clientX;
        setWidth(Math.max(min, Math.min(max, startW + delta)));
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [direction, min, max],
  );
  return [width, onMouseDown] as const;
}
