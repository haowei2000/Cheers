/* Shared behaviour for the kit. Nine components need overlay mechanics; writing
   the positioning and dismissal nine times is how a kit rots. Everything here
   leans on the platform first — <dialog> for modality, the Popover API for the
   top layer and light dismiss — and only fills the gaps the platform leaves. */

/** Position a popover-API element against its trigger. The platform gives us
 *  the top layer and light dismiss; placement is the part still missing in
 *  browsers without CSS anchor positioning. */
export function positionOverlay(trigger, panel, { placement = "bottom-start", gap = 6 } = {}) {
  const t = trigger.getBoundingClientRect();
  const p = panel.getBoundingClientRect();
  const [side, align = "start"] = placement.split("-");
  let top = side === "top" ? t.top - p.height - gap : t.bottom + gap;
  let left = align === "end" ? t.right - p.width : align === "center" ? t.left + (t.width - p.width) / 2 : t.left;
  // Flip and shift so the panel always lands inside the viewport.
  if (top + p.height > innerHeight - 8 && t.top - p.height - gap > 8) top = t.top - p.height - gap;
  left = Math.min(Math.max(8, left), innerWidth - p.width - 8);
  panel.style.position = "fixed";
  panel.style.insetInlineStart = `${left}px`;
  panel.style.insetBlockStart = `${Math.max(8, top)}px`;
  panel.style.margin = "0";
}

/** Wire every [data-overlay-trigger] to its popover panel. */
export function initOverlays(root = document) {
  for (const trigger of root.querySelectorAll("[popovertarget]")) {
    const panel = root.getElementById?.(trigger.getAttribute("popovertarget"))
      ?? document.getElementById(trigger.getAttribute("popovertarget"));
    if (!panel) continue;
    panel.addEventListener("toggle", (e) => {
      const open = e.newState === "open";
      trigger.setAttribute("aria-expanded", String(open));
      if (open) {
        positionOverlay(trigger, panel, { placement: panel.dataset.placement || "bottom-start" });
        panel.querySelector("[autofocus], input, [role='menuitem'], button")?.focus();
      }
    });
  }
}

/** Modal and drawer: <dialog> already traps focus, handles Escape and makes the
 *  background inert. All that is left is opening and closing it. */
export function initDialogs(root = document) {
  for (const b of root.querySelectorAll("[data-dialog-open]"))
    b.addEventListener("click", () => document.getElementById(b.dataset.dialogOpen)?.showModal());
  for (const b of root.querySelectorAll("[data-dialog-close]"))
    b.addEventListener("click", () => b.closest("dialog")?.close());
  for (const d of root.querySelectorAll("dialog.ui-modal, dialog.ui-drawer")) {
    // Clicking the backdrop closes it; clicking the panel must not.
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  }
}

/** Roving focus for tablist, toolbar, menu and tree: one tab stop, arrows move. */
export function initRovingFocus(container, itemSelector, { vertical = false } = {}) {
  const items = () => [...container.querySelectorAll(itemSelector)].filter((i) => !i.disabled && i.getAttribute("aria-disabled") !== "true");
  container.addEventListener("keydown", (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const axis = vertical ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
    if (next && axis.includes(e.key)) {
      e.preventDefault();
      const target = list[(i + next + list.length) % list.length];
      for (const el of list) el.tabIndex = -1;
      target.tabIndex = 0; target.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const target = e.key === "Home" ? list[0] : list.at(-1);
      for (const el of list) el.tabIndex = -1;
      target.tabIndex = 0; target.focus();
    }
  });
}

/** Tabs: roving focus plus panel swapping. */
export function initTabs(root = document) {
  for (const list of root.querySelectorAll("[role='tablist']")) {
    initRovingFocus(list, "[role='tab']", { vertical: list.closest(".ui-tabs--vertical") !== null });
    list.addEventListener("click", (e) => {
      const tab = e.target.closest("[role='tab']");
      if (!tab || tab.getAttribute("aria-disabled") === "true") return;
      for (const t of list.querySelectorAll("[role='tab']")) {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = t.getAttribute("aria-controls") && document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      }
    });
  }
}

/** Toasts: one persistent live region, auto-dismiss paused on hover and focus. */
export function initToasts(region) {
  const timers = new WeakMap();
  const start = (el, ms) => timers.set(el, setTimeout(() => dismiss(el), ms));
  const stop = (el) => { clearTimeout(timers.get(el)); timers.delete(el); };
  const dismiss = (el) => { el.dataset.state = "exiting"; setTimeout(() => el.remove(), 200); };
  region.addEventListener("pointerenter", (e) => { const t = e.target.closest(".ui-toast"); if (t) stop(t); }, true);
  region.addEventListener("focusin", (e) => { const t = e.target.closest(".ui-toast"); if (t) stop(t); });
  region.addEventListener("click", (e) => { if (e.target.closest("[data-toast-dismiss]")) dismiss(e.target.closest(".ui-toast")); });
  return {
    push(el, ms = 6000) { region.append(el); if (ms) start(el, ms); return el; },
    dismiss,
  };
}

/** Tree view: arrows move, right expands, left collapses. */
export function initTree(tree) {
  initRovingFocus(tree, ".ui-tree__row", { vertical: true });
  tree.addEventListener("keydown", (e) => {
    const row = e.target.closest(".ui-tree__row");
    const item = row?.closest(".ui-tree__item");
    if (!item || !item.hasAttribute("aria-expanded")) return;
    if (e.key === "ArrowRight" && item.getAttribute("aria-expanded") === "false") { e.stopPropagation(); item.setAttribute("aria-expanded", "true"); }
    if (e.key === "ArrowLeft" && item.getAttribute("aria-expanded") === "true") { e.stopPropagation(); item.setAttribute("aria-expanded", "false"); }
  });
  tree.addEventListener("click", (e) => {
    const item = e.target.closest(".ui-tree__item");
    if (item?.hasAttribute("aria-expanded"))
      item.setAttribute("aria-expanded", String(item.getAttribute("aria-expanded") === "false"));
  });
}

export function initAll(root = document) {
  initOverlays(root); initDialogs(root); initTabs(root);
  for (const t of root.querySelectorAll(".ui-tree")) initTree(t);
  for (const t of root.querySelectorAll(".ui-toolbar")) initRovingFocus(t, "button");
}
