import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { apiFetch } from "@/api/client";

// pdf.js runs its parser in a web worker; Vite bundles the worker as an asset URL.
GlobalWorkerOptions.workerSrc = workerSrc;

// Renders a PDF (auth-fetched from `path`) page-by-page into stacked canvases.
// Used for native PDFs and for office docs converted to PDF server-side (Phase 2),
// both served by GET /files/:id/preview.
export function PdfViewer({ path }: { path: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    let doc: PDFDocumentProxy | null = null;
    setState("loading");

    (async () => {
      try {
        const res = await apiFetch(path);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.arrayBuffer();
        if (cancelled) return;
        doc = await getDocument({ data }).promise;
        const host = hostRef.current;
        if (cancelled || !host) return;
        host.replaceChildren();

        const scale = 1.3;
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          if (cancelled) return;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          canvas.width = Math.floor(viewport.width * outputScale);
          canvas.height = Math.floor(viewport.height * outputScale);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          canvas.className = "mx-auto mb-3 max-w-full rounded shadow-lg shadow-black/30";
          host.appendChild(canvas);
          await page.render({
            canvasContext: ctx,
            viewport,
            transform:
              outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
          }).promise;
        }
        if (!cancelled) setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();

    return () => {
      cancelled = true;
      if (doc) doc.destroy();
    };
  }, [path]);

  return (
    <div>
      {state === "loading" && (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading PDF…
        </div>
      )}
      {state === "error" && (
        <div className="py-12 text-center text-sm text-rose-400">Failed to load the PDF — try downloading the original.</div>
      )}
      <div
        ref={hostRef}
        className="max-h-[70vh] min-h-0 overflow-auto rounded-lg bg-zinc-950/40 p-2"
      />
    </div>
  );
}
