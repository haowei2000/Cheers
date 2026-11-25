import { parseLocator } from "../../../locator";
import { ACTION_ID, UUID } from "../../interaction";
import catalogV1 from "../../../../../../../design-system/a2ui-catalog.json";
import catalogV2 from "../../../../../../../design-system/a2ui-catalog-v2.json";

export const A2UI_VERSION_V1 = "v0.9.1";
export const A2UI_CATALOG_V1 = catalogV1.catalogId;
export const A2UI_VERSION = "1.0";
export const A2UI_CATALOG = catalogV2.catalogId;
const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type ProtoVersion = "v0.9.1" | "1.0";
type Binding = string | boolean | { path: string };
export type A2UIAccessibility = { label?: Binding; description?: Binding };
export type A2UICheck =
  | { rule: "required"; message?: string }
  | { rule: "minLength" | "maxLength"; value: number; message?: string }
  | { rule: "pattern"; value: string; message?: string };
export type A2UIAction = {
  event: { name: "cheers.open" | "cheers.compose" | "cheers.request" | "cheers.openNative" | "cheers.execute"; context: Record<string, unknown> };
};
export interface A2UIComponent {
  id: string;
  component: "Column" | "Row" | "Text" | "TextField" | "CheckBox" | "Button";
  children?: string[];
  text?: Binding;
  label?: Binding;
  placeholder?: Binding;
  value?: Binding;
  action?: A2UIAction;
  accessibility?: A2UIAccessibility;
  checks?: A2UICheck[];
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
function bindingKey(proto: ProtoVersion): "path" | "@path" {
  return proto === A2UI_VERSION ? "@path" : "path";
}
function normalizeBinding(value: unknown, proto: ProtoVersion, boolean = false): Binding {
  if (mapping(value)) {
    const key = bindingKey(proto);
    keys(value, [key]);
    const path = value[key];
    requireThat(typeof path === "string", "A binding needs a data path.");
    pointerSegments(path);
    return { path };
  }
  requireThat(boolean ? typeof value === "boolean" : typeof value === "string", "Invalid component value.");
  return value as string | boolean;
}
function parseAccessibility(raw: unknown, proto: ProtoVersion): A2UIAccessibility {
  requireThat(mapping(raw), "Invalid accessibility metadata.");
  keys(raw, ["label", "description"]);
  const result: A2UIAccessibility = {};
  if (raw.label !== undefined) result.label = normalizeBinding(raw.label, proto);
  if (raw.description !== undefined) result.description = normalizeBinding(raw.description, proto);
  return result;
}
function parseQuantifier(pattern: string, start: number): { next: number; repeating: boolean } | null {
  const ch = pattern[start];
  if (ch === "?" || ch === "*" || ch === "+") {
    return { next: start + 1, repeating: ch === "*" || ch === "+" };
  }
  if (ch === "{") {
    const end = pattern.indexOf("}", start + 1);
    if (end === -1) return null;
    const body = pattern.slice(start + 1, end);
    const match = /^(\d+)(?:,(\d*))?$/.exec(body);
    if (!match) return null;
    const min = Number(match[1]);
    const max = match[2] === undefined ? min : match[2] === "" ? Infinity : Number(match[2]);
    if (min > 256 || (Number.isFinite(max) && max > 256) || max < min) return null;
    return { next: end + 1, repeating: max > 1 };
  }
  return null;
}
function isSafeCheckPattern(pattern: string): boolean {
  const stack: Array<{ hasQuantifier: boolean; hasAlternation: boolean }> = [{ hasQuantifier: false, hasAlternation: false }];
  let inClass = false;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\") {
      if (i + 1 >= pattern.length) return false;
      const next = pattern[i + 1];
      if ((next >= "1" && next <= "9") || next === "k") return false;
      i += 2;
      const q = parseQuantifier(pattern, i);
      if (q) {
        stack[stack.length - 1].hasQuantifier = true;
        i = q.next;
        if (parseQuantifier(pattern, i)) return false;
      }
      continue;
    }
    if (inClass) {
      if (ch === "]") {
        inClass = false;
        i += 1;
        const q = parseQuantifier(pattern, i);
        if (q) {
          stack[stack.length - 1].hasQuantifier = true;
          i = q.next;
          if (parseQuantifier(pattern, i)) return false;
        }
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === "[") {
      inClass = true;
      i += 1;
      continue;
    }
    if (ch === "(") {
      if (pattern[i + 1] === "?" && (pattern[i + 2] === "=" || pattern[i + 2] === "!" || pattern[i + 2] === "<")) {
        return false;
      }
      stack.push({ hasQuantifier: false, hasAlternation: false });
      i += 1;
      continue;
    }
    if (ch === ")") {
      if (stack.length <= 1) return false;
      const group = stack.pop()!;
      i += 1;
      const q = parseQuantifier(pattern, i);
      if (q) {
        if (q.repeating && (group.hasQuantifier || group.hasAlternation)) return false;
        stack[stack.length - 1].hasQuantifier = true;
        i = q.next;
        if (parseQuantifier(pattern, i)) return false;
      } else if (group.hasQuantifier) {
        stack[stack.length - 1].hasQuantifier = true;
      }
      continue;
    }
    if (ch === "|") {
      stack[stack.length - 1].hasAlternation = true;
      i += 1;
      continue;
    }
    i += 1;
    const q = parseQuantifier(pattern, i);
    if (q) {
      stack[stack.length - 1].hasQuantifier = true;
      i = q.next;
      if (parseQuantifier(pattern, i)) return false;
    }
  }
  return !inClass && stack.length === 1;
}
function parseChecks(raw: unknown): A2UICheck[] {
  requireThat(Array.isArray(raw) && raw.length <= 8, "Invalid component checks.");
  return raw.map((item) => {
    requireThat(mapping(item) && typeof item.rule === "string", "Invalid check rule.");
    const message = item.message;
    requireThat(message === undefined || (typeof message === "string" && message.length <= 256), "Invalid check message.");
    if (item.rule === "required") {
      keys(item, ["rule", "message"]);
      return message !== undefined ? { rule: "required", message } : { rule: "required" };
    }
    if (item.rule === "minLength" || item.rule === "maxLength") {
      keys(item, ["rule", "value", "message"]);
      const min = item.rule === "minLength" ? 0 : 1;
      requireThat(typeof item.value === "number" && Number.isInteger(item.value) && item.value >= min && item.value <= 4096, "Invalid check length bound.");
      return message !== undefined ? { rule: item.rule, value: item.value, message } : { rule: item.rule, value: item.value };
    }
    if (item.rule === "pattern") {
      keys(item, ["rule", "value", "message"]);
      requireThat(typeof item.value === "string" && item.value.length >= 1 && item.value.length <= 256, "Invalid check pattern.");
      requireThat(isSafeCheckPattern(item.value), "Unsafe check pattern.");
      try { new RegExp(item.value); } catch { throw new Error("Invalid check pattern."); }
      return message !== undefined ? { rule: "pattern", value: item.value, message } : { rule: "pattern", value: item.value };
    }
    throw new Error("Unsupported check rule.");
  });
}
export function validateFieldChecks(value: string, checks?: A2UICheck[]): string | null {
  if (!checks?.length) return null;
  for (const check of checks) {
    if (check.rule === "required" && !value.trim()) return check.message ?? "This field is required.";
    if (check.rule === "minLength" && value.length < check.value) return check.message ?? `Enter at least ${check.value} characters.`;
    if (check.rule === "maxLength" && value.length > check.value) return check.message ?? `Enter at most ${check.value} characters.`;
    if (check.rule === "pattern" && value.length > 0) {
      if (value.length > 4096 || !isSafeCheckPattern(check.value)) {
        return check.message ?? "Value does not match the required format.";
      }
      try {
        if (!new RegExp(check.value).test(value)) return check.message ?? "Value does not match the required format.";
      } catch {
        return check.message ?? "Value does not match the required format.";
      }
    }
  }
  return null;
}
function parseComponent(raw: unknown, sourcePath: (string | number)[], proto: ProtoVersion): A2UIComponent {
  requireThat(mapping(raw) && typeof raw.id === "string" && ID.test(raw.id), "Invalid component id.");
  const component = raw.component;
  const activeCatalog = proto === A2UI_VERSION ? catalogV2 : catalogV1;
  requireThat(Object.prototype.hasOwnProperty.call(activeCatalog.components, String(component)), "This component is not in the Cheers catalog.");
  const common = proto === A2UI_VERSION ? ["id", "component", "@accessibility"] : ["id", "component"];
  const accessibility = proto === A2UI_VERSION && raw["@accessibility"] !== undefined ? parseAccessibility(raw["@accessibility"], proto) : undefined;
  const base: A2UIComponent = { id: raw.id, component: component as A2UIComponent["component"], ...(accessibility ? { accessibility } : {}), sourcePath };
  if (component === "Column" || component === "Row") {
    keys(raw, [...common, "children"]);
    requireThat(Array.isArray(raw.children) && raw.children.length <= 256 && raw.children.every((id) => typeof id === "string" && ID.test(id)), "Invalid child list.");
    requireThat(new Set(raw.children).size === raw.children.length, "Duplicate child reference.");
    base.children = raw.children as string[];
  } else if (component === "Text") {
    keys(raw, [...common, "text"]);
    base.text = normalizeBinding(raw.text, proto);
  } else if (component === "TextField" || component === "CheckBox") {
    const allowed = component === "TextField" && proto === A2UI_VERSION
      ? [...common, "label", "value", "placeholder", "@checks"]
      : [...common, "label", "value"];
    keys(raw, allowed);
    base.label = normalizeBinding(raw.label, proto);
    const key = bindingKey(proto);
    requireThat(mapping(raw.value) && typeof raw.value[key] === "string" && pointerSegments(raw.value[key] as string).length > 0, "Inputs need a writable non-root data path.");
    base.value = normalizeBinding(raw.value, proto, component === "CheckBox");
    if (component === "TextField" && proto === A2UI_VERSION) {
      if (raw.placeholder !== undefined) base.placeholder = normalizeBinding(raw.placeholder, proto);
      if (raw["@checks"] !== undefined) base.checks = parseChecks(raw["@checks"]);
    }
  } else {
    keys(raw, [...common, "label", "action"]);
    base.label = normalizeBinding(raw.label, proto);
    requireThat(mapping(raw.action), "A button needs an action.");
    keys(raw.action, ["event"]);
    requireThat(mapping(raw.action.event), "Only registered event actions are supported.");
    keys(raw.action.event, ["name", "context"]);
    const eventName = String(raw.action.event.name);
    requireThat(["cheers.open", "cheers.compose", "cheers.request", "cheers.openNative", "cheers.execute"].includes(eventName), "This action binding is not supported.");
    requireThat(mapping(raw.action.event.context), "Action context must be an object.");
    const normalizedContext: Record<string, unknown> = {};
    if (eventName === "cheers.open" || eventName === "cheers.openNative") {
      const native = eventName === "cheers.openNative";
      keys(raw.action.event.context, native ? ["uri", "opener"] : ["uri"]);
      normalizedContext.uri = normalizeBinding(raw.action.event.context.uri, proto);
      if (typeof raw.action.event.context.uri === "string") requireThat(parseLocator(raw.action.event.context.uri), "Invalid resource locator.");
      if (native) {
        requireThat(["finder", "vscode", "zed"].includes(String(raw.action.event.context.opener)), "This native opener is not supported.");
        normalizedContext.opener = raw.action.event.context.opener;
      }
    } else {
      const request = eventName === "cheers.request" || eventName === "cheers.execute";
      keys(raw.action.event.context, request ? ["actionId", "payload", "botId"] : ["actionId", "payload"]);
      if (request) {
        requireThat(typeof raw.action.event.context.botId === "string" && UUID.test(raw.action.event.context.botId), "Requests need a stable bot id.");
        normalizedContext.botId = raw.action.event.context.botId;
      }
      requireThat(typeof raw.action.event.context.actionId === "string" && ACTION_ID.test(raw.action.event.context.actionId), "Invalid compose action id.");
      normalizedContext.actionId = raw.action.event.context.actionId;
      requireThat(mapping(raw.action.event.context.payload), "Compose payload must be an object.");
      const normalizedPayload: Record<string, unknown> = {};
      for (const [k, value] of Object.entries(raw.action.event.context.payload)) {
        if (mapping(value)) normalizedPayload[k] = normalizeBinding(value, proto);
        else {
          requireThat(value === null || ["string", "boolean", "number"].includes(typeof value), "Unsupported action value.");
          normalizedPayload[k] = value;
        }
      }
      normalizedContext.payload = normalizedPayload;
    }
    base.action = { event: { name: eventName as A2UIAction["event"]["name"], context: normalizedContext } };
  }
  return base;
}

/** A persisted file wraps an ordered protocol transcript. This wrapper is a
 * Cheers storage convention; each message uses the pinned A2UI envelope. */
export function parseA2UIDocument(raw: unknown): A2UISurface[] {
  requireThat(mapping(raw), "Expected an A2UI document.");
  keys(raw, ["a2ui", "messages", "views"]);
  requireThat(raw.a2ui === A2UI_VERSION || raw.a2ui === A2UI_VERSION_V1, "Unsupported A2UI version; expected 1.0 or v0.9.1.");
  const proto: ProtoVersion = raw.a2ui;
  const expectedCatalog = proto === A2UI_VERSION ? A2UI_CATALOG : A2UI_CATALOG_V1;
  requireThat(Array.isArray(raw.messages) && raw.messages.length <= 256, "Expected at most 256 A2UI messages.");
  const serialized = JSON.stringify(raw);
  requireThat(serialized.length <= 256_000, "A2UI document is too large.");
  safeJson(raw);
  const surfaces = new Map<string, A2UISurface>();
  const applyComponents = (surface: A2UISurface, components: unknown, pathPrefix: (string | number)[]) => {
    requireThat(Array.isArray(components) && components.length <= 256, "Too many components.");
    const ids = new Set<string>();
    components.forEach((value, index) => {
      const parsed = parseComponent(value, [...pathPrefix, index], proto);
      requireThat(!ids.has(parsed.id), "Duplicate component in one update.");
      ids.add(parsed.id);
      surface.components.set(parsed.id, parsed);
    });
    requireThat(surface.components.size <= 256, "Too many surface components.");
  };
  raw.messages.forEach((message, at) => {
    requireThat(mapping(message) && message.version === proto, `Every message must use ${proto}.`);
    const kinds = ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"].filter((key) => key in message);
    requireThat(kinds.length === 1, "Each message needs exactly one operation.");
    const kind = kinds[0];
    keys(message, ["version", kind]);
    const body = message[kind];
    requireThat(mapping(body) && typeof body.surfaceId === "string" && ID.test(body.surfaceId), "Invalid surface id.");
    if (kind === "createSurface") {
      keys(body, proto === A2UI_VERSION ? ["surfaceId", "catalogId", "components", "dataModel"] : ["surfaceId", "catalogId"]);
      requireThat(body.catalogId === expectedCatalog, "This A2UI catalog is not supported.");
      requireThat(!surfaces.has(body.surfaceId) && surfaces.size < 8, "Duplicate surface or too many surfaces.");
      const surface: A2UISurface = { id: body.surfaceId, components: new Map(), data: {} };
      if (proto === A2UI_VERSION) {
        if (body.dataModel !== undefined) surface.data = setDataPath({}, "/", body.dataModel);
        if (body.components !== undefined) applyComponents(surface, body.components, ["messages", at, "createSurface", "components"]);
      }
      surfaces.set(body.surfaceId, surface);
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
      applyComponents(surface, body.components, ["messages", at, "updateComponents", "components"]);
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
