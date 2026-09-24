import { useEffect, useMemo, useRef } from "react";
import toast from "react-hot-toast";
import type { LensProps } from "./registry";

export interface ArtifactLensProps extends LensProps {
  mode: "html" | "react";
}

const INSPECTOR_CSS = `
.cheers-inspector-overlay {
  position: fixed;
  pointer-events: none;
  border: 2px dashed #2563eb;
  background-color: rgba(37, 99, 235, 0.12);
  z-index: 2147483640;
  box-sizing: border-box;
  display: none;
  transition: all 0.05s ease-out;
}
.cheers-inspector-badge {
  position: absolute;
  left: 0;
  top: -22px;
  background-color: #1d4ed8;
  color: #ffffff;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  line-height: 14px;
  padding: 2px 6px;
  border-radius: 4px;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}
`;

const BRIDGE_SCRIPT = `
(() => {
  let inspectorEnabled = false;
  let overlay = null;
  let badge = null;

  const ensureOverlay = () => {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "cheers-inspector-overlay";
      badge = document.createElement("div");
      badge.className = "cheers-inspector-badge";
      overlay.appendChild(badge);
      document.body.appendChild(overlay);
    }
    return overlay;
  };

  const getDomPath = (el) => {
    if (!el || el.nodeType !== 1) return "";
    const parts = [];
    let curr = el;
    while (curr && curr.nodeType === 1 && curr !== document.body && curr !== document.documentElement) {
      let seg = curr.tagName.toLowerCase();
      if (curr.id) {
        seg += "#" + curr.id;
        parts.unshift(seg);
        break;
      }
      if (curr.classList && curr.classList.length > 0) {
        const first = curr.classList[0];
        if (first && !first.startsWith("cheers-")) seg += "." + first;
      }
      let sibling = curr;
      let nth = 1;
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName === curr.tagName) nth++;
      }
      if (nth > 1) seg += ":nth-of-type(" + nth + ")";
      parts.unshift(seg);
      curr = curr.parentElement;
    }
    return parts.join(" > ");
  };

  const onPointerMove = (e) => {
    if (!inspectorEnabled) return;
    const target = e.target;
    if (!target || target === overlay || overlay?.contains(target)) return;
    const r = target.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const ov = ensureOverlay();
    ov.style.display = "block";
    ov.style.left = r.left + "px";
    ov.style.top = r.top + "px";
    ov.style.width = r.width + "px";
    ov.style.height = r.height + "px";
    const tag = target.tagName.toLowerCase();
    const cls = target.className && typeof target.className === "string" ? "." + target.className.trim().split(/\\s+/)[0] : "";
    badge.textContent = "<" + tag + (cls ? cls.slice(0, 16) : "") + ">";
    badge.style.top = r.top < 24 ? "0px" : "-22px";
  };

  const onClick = (e) => {
    if (!inspectorEnabled) return;
    const target = e.target;
    if (!target || target === overlay || overlay?.contains(target)) return;
    e.preventDefault();
    e.stopPropagation();
    const r = target.getBoundingClientRect();
    const label = target.getAttribute("aria-label") || target.innerText?.trim().slice(0, 32) || target.tagName.toLowerCase();
    const domPath = getDomPath(target);
    const sourceText = (target.outerHTML || "").slice(0, 500);
    parent.postMessage({
      jsonrpc: "2.0",
      method: "inspector.inspect",
      params: {
        x: Math.round(r.left),
        y: Math.round(r.bottom),
        label,
        domPath,
        sourceText
      }
    }, "*");
  };

  const setInspector = (enabled) => {
    inspectorEnabled = Boolean(enabled);
    if (inspectorEnabled) {
      document.addEventListener("pointermove", onPointerMove, true);
      document.addEventListener("click", onClick, true);
    } else {
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("click", onClick, true);
      if (overlay) overlay.style.display = "none";
    }
  };

  window.addEventListener("message", (event) => {
    if (event.source !== parent || !event.data || event.data.jsonrpc !== "2.0") return;
    if (event.data.method === "inspector.toggle") {
      setInspector(event.data.params?.enabled);
    }
  });

  // Global Bridge SDK for components
  const bridge = {
    submit: (formData, actionId = "submit") => {
      parent.postMessage({ jsonrpc: "2.0", method: "form.submit", params: { actionId, formData } }, "*");
    },
    trigger: (actionId, payload = {}) => {
      parent.postMessage({ jsonrpc: "2.0", method: "action.trigger", params: { actionId, payload } }, "*");
    }
  };
  window.CheersBridge = bridge;

  // Intercept standard HTML form submissions
  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (!form || form.tagName !== "FORM") return;
    e.preventDefault();
    const formData = {};
    new FormData(form).forEach((val, key) => {
      formData[key] = val;
    });
    const actionId = form.getAttribute("name") || form.getAttribute("id") || "form_submit";
    bridge.submit(formData, actionId);
  }, true);
})();
`;

export function buildArtifactHtml(source: string, mode: "html" | "react"): string {
  const trimmed = (source || "").trim();

  if (mode === "html") {
    // If it's already a full HTML document
    if (/<html[\s>]/i.test(trimmed)) {
      const injection = `<style>${INSPECTOR_CSS}</style><script>${BRIDGE_SCRIPT}</script>`;
      if (/<head[\s>]/i.test(trimmed)) {
        return trimmed.replace(/<head[\s>]/i, (match) => `${match}${injection}`);
      }
      return `${injection}${trimmed}`;
    }

    // Otherwise wrap snippet
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    html, body { min-height: 100%; margin: 0; padding: 1rem; }
    ${INSPECTOR_CSS}
  </style>
</head>
<body>
  ${trimmed || '<div class="text-zinc-400 p-4">Empty HTML Canvas</div>'}
  <script>${BRIDGE_SCRIPT}</script>
</body>
</html>`;
  }

  // mode === "react" (.tsx / .jsx)
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <style>
    html, body, #root { height: 100%; margin: 0; padding: 0; }
    ${INSPECTOR_CSS}
  </style>
</head>
<body>
  <div id="root"></div>
  <script>${BRIDGE_SCRIPT}</script>
  <script type="text/babel" data-presets="react,typescript">
    (() => {
      try {
        const { useState, useEffect, useRef, useMemo, useCallback } = React;
        const exports = {};
        const module = { exports };

        // Strip module imports that browsers cannot resolve directly
        const rawCode = ${JSON.stringify(trimmed)};
        const sanitizedCode = rawCode
          .replace(/^\\s*import\\s+.*?from\\s+['"].*?['"];?\\s*$/gm, '')
          .replace(/^\\s*export\\s+default\\s+/gm, 'window.__CHEERS_ROOT_COMPONENT__ = ')
          .replace(/^\\s*export\\s+(const|function|let|var|class)\\s+/gm, '$1 ');

        // Evaluate in scope
        eval(Babel.transform(sanitizedCode, { presets: ['react', 'typescript'] }).code);

        const Component = window.__CHEERS_ROOT_COMPONENT__ || window.App || window.Main;
        const rootEl = document.getElementById("root");
        if (Component && rootEl) {
          const root = ReactDOM.createRoot(rootEl);
          root.render(React.createElement(Component));
        } else if (rootEl) {
          rootEl.innerHTML = '<div class="p-6 text-zinc-500 font-sans">Ready. Provide an export default React component to preview.</div>';
        }
      } catch (err) {
        const rootEl = document.getElementById("root");
        if (rootEl) {
          rootEl.innerHTML = '<div class="p-4 bg-red-50 text-red-700 rounded-md font-mono text-sm border border-red-200"><strong>React Render Error:</strong><br>' + err.message + '</div>';
        }
      }
    })();
  </script>
</body>
</html>`;
}

export function ArtifactLens({
  data,
  mode,
  inspectorActive,
  requestContextPick,
  onFormSubmit,
}: ArtifactLensProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const content = typeof data === "string" ? data : "";
  const documentHtml = useMemo(() => buildArtifactHtml(content, mode), [content, mode]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({
      jsonrpc: "2.0",
      method: "inspector.toggle",
      params: { enabled: Boolean(inspectorActive) },
    }, "*");
  }, [inspectorActive]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.data?.jsonrpc !== "2.0") return;
      const { method, params } = event.data;

      if (method === "inspector.inspect") {
        const frame = iframeRef.current?.getBoundingClientRect();
        const clientX = (frame?.left ?? 0) + Number(params?.x ?? 0);
        const clientY = (frame?.top ?? 0) + Number(params?.y ?? 0);
        const label = String(params?.label ?? "element").trim();
        const sourceText = String(params?.sourceText ?? "");
        const domPath = String(params?.domPath ?? "");

        const fakeEvent = {
          clientX,
          clientY,
          preventDefault: () => {},
          stopPropagation: () => {},
          currentTarget: iframeRef.current,
        } as unknown as React.MouseEvent<Element>;

        requestContextPick?.(fakeEvent, {
          label: `<${label}>`,
          sourceText: sourceText || undefined,
          sourcePath: domPath ? [domPath] : undefined,
        });
      } else if (method === "form.submit" || method === "action.trigger") {
        const actionId = String(params?.actionId ?? "submit");
        const formData = (params?.formData ?? params?.payload ?? {}) as Record<string, unknown>;
        toast.success(`Action submitted: ${actionId}`);
        onFormSubmit?.({ actionId, formData });
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onFormSubmit, requestContextPick]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-white">
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts allow-forms"
        srcDoc={documentHtml}
        title={`${mode.toUpperCase()} Canvas`}
        className="h-full w-full border-0"
      />
    </div>
  );
}
