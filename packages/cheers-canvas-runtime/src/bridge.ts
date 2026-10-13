export const INSPECTOR_CSS = `
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
[data-cheers-canvas] { position: relative; min-height: 100%; }
[data-cheers-canvas] [data-cheers-id][data-cheers-position] { position: absolute; }
.cheers-design-mode [data-cheers-canvas] [data-cheers-id][data-cheers-position] { cursor: grab; touch-action: none; }
.cheers-design-mode [data-cheers-canvas] [data-cheers-id][data-cheers-position]:active { cursor: grabbing; }
`;

export const BRIDGE_SCRIPT = `
(() => {
  let inspectorEnabled = false;
  let canvasWritable = false;
  let overlay = null;
  let badge = null;
  let drag = null;
  let suppressClick = false;

  const canvasPosition = (element) => {
    const match = element?.getAttribute("data-cheers-position")?.match(/^(-?\\d+),(-?\\d+)$/);
    return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
  };
  const applyCanvasPositions = () => {
    document.querySelectorAll("[data-cheers-canvas] [data-cheers-id][data-cheers-position]").forEach((card) => {
      if (drag?.card === card) return;
      const pos = canvasPosition(card);
      if (!pos) return;
      card.style.left = pos.x + "px";
      card.style.top = pos.y + "px";
    });
  };
  const canvasObserver = new MutationObserver(applyCanvasPositions);
  canvasObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-cheers-position"] });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applyCanvasPositions, { once: true });
  else applyCanvasPositions();

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
    const target = e.target?.closest?.("[data-cheers-id]") || e.target;
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
    badge.textContent = "<" + tag + (cls ? cls.slice(0, 16) : "") + ">"
      + (canvasWritable && target.hasAttribute("data-cheers-position") ? " · drag" : "");
    badge.style.top = r.top < 24 ? "0px" : "-22px";
  };

  const onClick = (e) => {
    if (!inspectorEnabled) return;
    if (suppressClick) { e.preventDefault(); e.stopPropagation(); suppressClick = false; return; }
    const target = e.target?.closest?.("[data-cheers-id]") || e.target;
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
        sourceText,
        inspectableId: target.getAttribute("data-cheers-id"),
        sourceLine: target.getAttribute("data-cheers-source"),
        sourceUri: target.getAttribute("data-cheers-source-uri"),
      }
    }, "*");
  };

  const onCanvasPointerDown = (e) => {
    if (!inspectorEnabled || !canvasWritable || e.button !== 0) return;
    const card = e.target?.closest?.("[data-cheers-canvas] [data-cheers-id][data-cheers-position]");
    const pos = canvasPosition(card);
    if (!card || !pos) return;
    drag = { card, id: card.getAttribute("data-cheers-id"), pointer: e.pointerId,
      startX: e.clientX, startY: e.clientY, x: pos.x, y: pos.y, moved: false };
    card.setPointerCapture(e.pointerId);
  };
  const onCanvasPointerMove = (e) => {
    if (!drag || drag.pointer !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    e.preventDefault();
    drag.card.style.left = Math.round(drag.x + dx) + "px";
    drag.card.style.top = Math.round(drag.y + dy) + "px";
  };
  const onCanvasPointerUp = (e) => {
    if (!drag || drag.pointer !== e.pointerId) return;
    const finished = drag;
    drag = null;
    if (!finished.moved) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    e.preventDefault();
    e.stopPropagation();
    parent.postMessage({ jsonrpc: "2.0", method: "canvas.move", params: {
      id: finished.id,
      x: Math.round(finished.x + e.clientX - finished.startX),
      y: Math.round(finished.y + e.clientY - finished.startY),
    } }, "*");
  };
  document.addEventListener("pointerdown", onCanvasPointerDown, true);
  document.addEventListener("pointermove", onCanvasPointerMove, true);
  document.addEventListener("pointerup", onCanvasPointerUp, true);
  document.addEventListener("pointercancel", () => { drag = null; applyCanvasPositions(); }, true);

  const setInspector = (enabled) => {
    inspectorEnabled = Boolean(enabled);
    document.documentElement.classList.toggle("cheers-design-mode", inspectorEnabled);
    if (inspectorEnabled) {
      document.addEventListener("pointermove", onPointerMove, true);
      document.addEventListener("click", onClick, true);
    } else {
      drag = null;
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("click", onClick, true);
      if (overlay) overlay.style.display = "none";
    }
  };

  const onContextMenu = (e) => {
    const target = e.target?.closest?.("[data-cheers-id]") || e.target;
    if (!target || target === overlay || overlay?.contains(target)) return;
    e.preventDefault();
    e.stopPropagation();
    const label = target.getAttribute("aria-label")
      || target.getAttribute("title")
      || target.id
      || (target.innerText?.trim().slice(0, 32))
      || target.tagName.toLowerCase();
    const domPath = getDomPath(target);
    const sourceText = (target.outerHTML || "").slice(0, 500);
    parent.postMessage({
      jsonrpc: "2.0",
      method: "context.pick",
      params: {
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        label,
        domPath,
        sourceText,
        inspectableId: target.getAttribute("data-cheers-id"),
        sourceLine: target.getAttribute("data-cheers-source"),
        sourceUri: target.getAttribute("data-cheers-source-uri"),
      }
    }, "*");
  };
  document.addEventListener("contextmenu", onContextMenu, true);

  window.addEventListener("message", (event) => {
    if (event.source !== parent || !event.data || event.data.jsonrpc !== "2.0") return;
    if (event.data.method === "inspector.toggle") {
      canvasWritable = Boolean(event.data.params?.editable);
      setInspector(event.data.params?.enabled);
    } else if (event.data.method === "canvas.revert") {
      applyCanvasPositions();
    }
  });

  // Global Bridge SDK for components
  const bridge = {
    submit: (formData, actionId = "submit") => {
      parent.postMessage({ jsonrpc: "2.0", method: "form.submit", params: { actionId, formData } }, "*");
    },
    trigger: (actionId, payload = {}) => {
      parent.postMessage({ jsonrpc: "2.0", method: "action.trigger", params: { actionId, payload } }, "*");
    },
    request: (actionId, payload = {}) => {
      parent.postMessage({ jsonrpc: "2.0", method: "cheers.request", params: { actionId, payload } }, "*");
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

export function artifactCsp(): string {
  return [
    "default-src 'none'",
    // Inline code is intentional in this opaque-origin frame; external scripts and eval
    // remain blocked. A nonce would let authored code load external scripts with it.
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "connect-src 'none'",
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data:",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "navigate-to 'none'",
  ].join("; ");
}

export const escapeScript = (code: string): string => code.replace(/<\/script/gi, "<\\/script");
export const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const boundedText = (value: unknown, maxLength: number): string =>
  typeof value === "string" ? value.slice(0, maxLength) : "";

export function boundedPayload(value: unknown): Record<string, string | number | boolean | null> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 32) return null;
  const result: Record<string, string | number | boolean | null> = Object.create(null);
  let total = 0;
  for (const [key, item] of entries) {
    if (!key || key.length > 80 || key === "__proto__" || key === "prototype" || key === "constructor") return null;
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean" && item !== null) return null;
    if (typeof item === "number" && !Number.isFinite(item)) return null;
    total += key.length + String(item).length;
    if (total > 8192) return null;
    result[key] = item;
  }
  return result;
}
