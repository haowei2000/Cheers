import { parseLocator } from "../../../locator";
import catalog from "../../../../../../../design-system/a2ui-catalog.json";

export const A2UI_VERSION = "v0.9.1";
export const A2UI_CATALOG = catalog.catalogId;
const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type Binding = string | boolean | { path: string };
export type A2UIAction = {
  event: { name: "cheers.open" | "cheers.compose" | "cheers.request" | "cheers.openNative"; context: Record<string, unknown> };
};
export interface A2UIComponent {
  id: string;
  component: "Column" | "Row" | "Text" | "TextField" | "CheckBox" | "Button";
  children?: string[];
  text?: Binding;
  label?: Binding;
  value?: Binding;
  action?: A2UIAction;
  sourcePath: (string | number)[];
}
export interface A2UISurface {
  id: string;
  components: Map<string, A2UIComponent>;
  data: Record<string, unknown>;
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  requireThat(Object.keys(value).every((key) => allowed.includes(key)), "Unsupported A2UI property.");
}
export function pointerSegments(path: string): string[] {
  requireThat(path === "/" || path === "" || path.startsWith("/"), "Only absolute data paths are supported.");
  if (path === "/" || path === "") return [];
  requireThat(path.length <= 1024 && !/~(?![01])/.test(path), "Invalid data path.");
  const segments = path.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  requireThat(segments.length <= 32 && segments.every((part) => !BAD_KEYS.has(part)), "Unsafe data path.");
  return segments;
}
export function readBinding(value: unknown, data: Record<string, unknown>): unknown {
  if (mapping(value) && typeof value.path === "string") {
    let current: unknown = data;
    for (const part of pointerSegments(value.path)) {
      if (!mapping(current) && !Array.isArray(current)) return undefined;
      if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
  return value;
}

/** Immutable local draft updates; never write the source file or mutate shared data. */
export function setDataPath(data: Record<string, unknown>, path: string, value?: unknown, remove = false): Record<string, unknown> {
  const parts = pointerSegments(path);
  if (!parts.length) {
    requireThat(!remove && mapping(value), "The root data model must be an object.");
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  }
  const next = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  let current: Record<string, unknown> | unknown[] = next;
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index];
    if (Array.isArray(current)) requireThat(/^(0|[1-9]\d*)$/.test(part) && Number(part) < current.length, "Invalid array index.");
    let child: unknown = (current as Record<string, unknown>)[part];
    if (child === undefined) {
      child = {};
      (current as Record<string, unknown>)[part] = child;
    }
    requireThat(mapping(child) || Array.isArray(child), "A data path crosses a scalar value.");
    current = child;
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(current)) {
    requireThat(/^(0|[1-9]\d*)$/.test(last) && Number(last) < current.length, "Invalid array index.");
    if (remove) current.splice(Number(last), 1);
    else current[Number(last)] = value;
  } else if (remove) delete current[last];
  else current[last] = value;
  return next;
}

function safeJson(value: unknown, depth = 0): void {
  requireThat(depth <= 32, "A2UI data is nested too deeply.");
  if (Array.isArray(value)) {
    requireThat(value.length <= 1024, "A2UI array is too large.");
    value.forEach((item) => safeJson(item, depth + 1));
  } else if (mapping(value)) {
    requireThat(Object.keys(value).length <= 1024, "A2UI object is too large.");
    for (const [key, item] of Object.entries(value)) {
      requireThat(!BAD_KEYS.has(key), "Unsafe A2UI data key.");
      safeJson(item, depth + 1);
    }
  } else requireThat(value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)), "A2UI data must be JSON.");
}
function binding(value: unknown, boolean = false): void {
  if (mapping(value)) {
    keys(value, ["path"]);
    requireThat(typeof value.path === "string", "A binding needs a data path.");
    pointerSegments(value.path);
  } else requireThat(boolean ? typeof value === "boolean" : typeof value === "string", "Invalid component value.");
}
function parseComponent(raw: unknown, sourcePath: (string | number)[]): A2UIComponent {
  requireThat(mapping(raw) && typeof raw.id === "string" && ID.test(raw.id), "Invalid component id.");
  const component = raw.component;
  requireThat(Object.prototype.hasOwnProperty.call(catalog.components, String(component)), "This component is not in the Cheers catalog.");
  const common = ["id", "component"];
  if (component === "Column" || component === "Row") {
    keys(raw, [...common, "children"]);
    requireThat(Array.isArray(raw.children) && raw.children.length <= 256 && raw.children.every((id) => typeof id === "string" && ID.test(id)), "Invalid child list.");
    requireThat(new Set(raw.children).size === raw.children.length, "Duplicate child reference.");
  } else if (component === "Text") {
    keys(raw, [...common, "text"]);
    binding(raw.text);
  } else if (component === "TextField" || component === "CheckBox") {
    keys(raw, [...common, "label", "value"]);
    binding(raw.label);
    requireThat(mapping(raw.value) && typeof raw.value.path === "string" && pointerSegments(raw.value.path).length > 0, "Inputs need a writable non-root data path.");
    binding(raw.value, component === "CheckBox");
  } else {
    keys(raw, [...common, "label", "action"]);
    binding(raw.label);
    requireThat(mapping(raw.action), "A button needs an action.");
    keys(raw.action, ["event"]);
    requireThat(mapping(raw.action.event), "Only registered event actions are supported.");
    keys(raw.action.event, ["name", "context"]);
    requireThat(["cheers.open", "cheers.compose", "cheers.request", "cheers.openNative"].includes(String(raw.action.event.name)), "This action binding is not supported.");
    requireThat(mapping(raw.action.event.context), "Action context must be an object.");
    if (raw.action.event.name === "cheers.open" || raw.action.event.name === "cheers.openNative") {
      const native = raw.action.event.name === "cheers.openNative";
      keys(raw.action.event.context, native ? ["uri", "opener"] : ["uri"]);
      binding(raw.action.event.context.uri);
      if (typeof raw.action.event.context.uri === "string") requireThat(parseLocator(raw.action.event.context.uri), "Invalid resource locator.");
      if (native) requireThat(["finder", "vscode", "zed"].includes(String(raw.action.event.context.opener)), "This native opener is not supported.");
    } else {
      const request = raw.action.event.name === "cheers.request";
      keys(raw.action.event.context, request ? ["actionId", "payload", "botId"] : ["actionId", "payload"]);
      if (request) requireThat(typeof raw.action.event.context.botId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.action.event.context.botId), "Requests need a stable bot id.");
      requireThat(typeof raw.action.event.context.actionId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(raw.action.event.context.actionId), "Invalid compose action id.");
      requireThat(mapping(raw.action.event.context.payload), "Compose payload must be an object.");
      for (const value of Object.values(raw.action.event.context.payload)) {
        if (mapping(value)) binding(value);
        else requireThat(value === null || ["string", "boolean", "number"].includes(typeof value), "Unsupported action value.");
      }
    }
  }
  return { ...raw, component, sourcePath } as unknown as A2UIComponent;
}

/** A persisted file wraps an ordered protocol transcript. This wrapper is a
 * Cheers storage convention; each message uses the pinned A2UI envelope. */
export function parseA2UIDocument(raw: unknown): A2UISurface[] {
  requireThat(mapping(raw), "Expected an A2UI document.");
  keys(raw, ["a2ui", "messages", "views"]);
  requireThat(raw.a2ui === A2UI_VERSION, "Unsupported A2UI version; expected v0.9.1.");
  requireThat(Array.isArray(raw.messages) && raw.messages.length <= 256, "Expected at most 256 A2UI messages.");
  const serialized = JSON.stringify(raw);
  requireThat(serialized.length <= 256_000, "A2UI document is too large.");
  safeJson(raw);
  const surfaces = new Map<string, A2UISurface>();
  raw.messages.forEach((message, at) => {
    requireThat(mapping(message) && message.version === A2UI_VERSION, "Every message must use v0.9.1.");
    const kinds = ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"].filter((key) => key in message);
    requireThat(kinds.length === 1, "Each message needs exactly one operation.");
    const kind = kinds[0];
    keys(message, ["version", kind]);
    const body = message[kind];
    requireThat(mapping(body) && typeof body.surfaceId === "string" && ID.test(body.surfaceId), "Invalid surface id.");
    if (kind === "createSurface") {
      keys(body, ["surfaceId", "catalogId"]);
      requireThat(body.catalogId === A2UI_CATALOG, "This A2UI catalog is not supported.");
      requireThat(!surfaces.has(body.surfaceId) && surfaces.size < 8, "Duplicate surface or too many surfaces.");
      surfaces.set(body.surfaceId, { id: body.surfaceId, components: new Map(), data: {} });
      return;
    }
    const surface = surfaces.get(body.surfaceId);
    requireThat(surface, "A surface must be created before it is updated or deleted.");
    if (kind === "deleteSurface") {
      keys(body, ["surfaceId"]);
      surfaces.delete(body.surfaceId);
    } else if (kind === "updateDataModel") {
      keys(body, ["surfaceId", "path", "value"]);
      requireThat(body.path === undefined || typeof body.path === "string", "Invalid data model path.");
      surface.data = setDataPath(surface.data, (body.path as string | undefined) ?? "/", body.value, !("value" in body));
    } else {
      keys(body, ["surfaceId", "components"]);
      requireThat(Array.isArray(body.components) && body.components.length <= 256, "Too many components.");
      const ids = new Set<string>();
      body.components.forEach((value, index) => {
        const parsed = parseComponent(value, ["messages", at, "updateComponents", "components", index]);
        requireThat(!ids.has(parsed.id), "Duplicate component in one update.");
        ids.add(parsed.id);
        surface.components.set(parsed.id, parsed);
      });
      requireThat(surface.components.size <= 256, "Too many surface components.");
    }
  });
  for (const surface of surfaces.values()) {
    requireThat(surface.components.has("root"), "The surface needs a root component.");
    let visited = 0;
    const walk = (id: string, ancestors: Set<string>) => {
      requireThat(!ancestors.has(id) && ancestors.size < 32 && ++visited <= 1024, "Cyclic or excessively large component tree.");
      const node = surface.components.get(id);
      requireThat(node, "A component references a missing child.");
      const next = new Set([...ancestors, id]);
      node.children?.forEach((child) => walk(child, next));
    };
    // Validate detached components too: a later update may connect them to root.
    for (const id of surface.components.keys()) walk(id, new Set());
  }
  if (raw.views !== undefined) {
    requireThat(mapping(raw.views), "Expected presentation views.");
    keys(raw.views, ["minimal", "medium"]);
    for (const view of Object.values(raw.views)) {
      requireThat(mapping(view), "Invalid presentation view.");
      keys(view, ["surfaceId", "root"]);
      requireThat(typeof view.surfaceId === "string" && typeof view.root === "string" &&
        surfaces.get(view.surfaceId)?.components.has(view.root), "Presentation view references a missing component.");
    }
  }
  return [...surfaces.values()];
}

/** Minimal views never silently omit inputs from a larger interactive form. */
export function a2uiPresentation(raw: unknown, surfaces: A2UISurface[], level: "minimal" | "medium" | "max") {
  const explicit = mapping(raw) && mapping(raw.views) ? raw.views[level] : undefined;
  const selected = mapping(explicit)
    ? surfaces.filter((surface) => surface.id === explicit.surfaceId).map((surface) => ({ surface, root: String(explicit.root) }))
    : surfaces.map((surface) => ({ surface, root: "root" }));
  if (level !== "minimal") return { selected, fits: true };
  let nodes = 0, fields = 0, actions = 0;
  const walk = (surface: A2UISurface, id: string) => {
    const node = surface.components.get(id)!;
    nodes++;
    if (node.component === "TextField" || node.component === "CheckBox") fields++;
    if (node.component === "Button") actions++;
    node.children?.forEach((child) => walk(surface, child));
  };
  selected.forEach(({ surface, root }) => walk(surface, root));
  return { selected, fits: selected.length <= 1 && nodes <= 16 && fields <= 3 && actions <= 2 };
}

export function acceptsA2UIDocument(raw: unknown): boolean {
  try { return parseA2UIDocument(raw).length > 0; } catch { return false; }
}
