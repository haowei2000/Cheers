import {
  MessageProcessor,
  type ActionListener,
  type ProcessableMessage,
  type SurfaceModel,
} from "@a2ui/web_core";
import { basicCatalog } from "@a2ui/web_core/catalogs/basic/v1";
import type { ReactCatalogComponent } from "@a2ui/react";
import { cheersBasicCatalog } from "./cheersCatalog";
import { parseLocator } from "../../../locator";
import { ACTION_ID, UUID } from "../../interaction";

export const A2UI_VERSION_V1 = "v0.9.1";
export const A2UI_CATALOG_V1 = "urn:cheers:a2ui:catalog:v1";
export const A2UI_CATALOG_V2 = "urn:cheers:a2ui:catalog:v2";
export const A2UI_VERSION = "1.0";
export const A2UI_CATALOG = basicCatalog.id;
export const A2UI_SUPPORTED_CATALOGS = new Set([
  basicCatalog.id,
  "https://a2ui.org/specification/v1_0/basic_catalog.json",
  A2UI_CATALOG_V2,
  A2UI_CATALOG_V1,
]);

const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type ProtoVersion = "v0.9.1" | "1.0";

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
  if (mapping(value)) {
    const path = typeof value["@path"] === "string" ? value["@path"] : typeof value.path === "string" ? value.path : null;
    if (path !== null) {
      let current: unknown = data;
      for (const part of pointerSegments(path)) {
        if (!mapping(current) && !Array.isArray(current)) return undefined;
        if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
        current = (current as Record<string, unknown>)[part];
      }
      return current;
    }
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
  } else {
    requireThat(
      value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)),
      "A2UI data must be JSON.",
    );
  }
}

function rewriteLegacyPaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteLegacyPaths);
  if (!mapping(value)) return value;
  const entries = Object.entries(value);
  if (entries.length === 1 && entries[0][0] === "path" && typeof entries[0][1] === "string") {
    pointerSegments(entries[0][1]);
    return { "@path": entries[0][1] };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    out[k] = rewriteLegacyPaths(v);
  }
  return out;
}

function convertLegacyChecks(rawChecks: unknown, fieldValue: unknown): unknown {
  if (!Array.isArray(rawChecks)) return rawChecks;
  return rawChecks.map((item) => {
    if (!mapping(item) || typeof item.rule !== "string") return item;
    const message = typeof item.message === "string" ? item.message : "Invalid value.";
    const valueRef = rewriteLegacyPaths(fieldValue);
    if (item.rule === "required") {
      return { condition: { "@call": "required", value: valueRef }, message };
    }
    if (item.rule === "minLength") {
      return { condition: { "@call": "length", value: valueRef, min: item.value }, message };
    }
    if (item.rule === "maxLength") {
      return { condition: { "@call": "length", value: valueRef, max: item.value }, message };
    }
    if (item.rule === "pattern") {
      return { condition: { "@call": "regex", value: valueRef, pattern: item.value }, message };
    }
    throw new Error("Unsupported check rule.");
  });
}

function validateCheersAction(action: unknown) {
  if (!mapping(action) || !mapping(action.event)) return;
  const event = action.event;
  if (typeof event.name !== "string" || !event.name.startsWith("cheers.")) return;
  requireThat(
    ["cheers.open", "cheers.compose", "cheers.request", "cheers.openNative", "cheers.execute"].includes(event.name),
    "This action binding is not supported.",
  );
  requireThat(mapping(event.context), "Action context must be an object.");
  const ctx = event.context;
  if (event.name === "cheers.open" || event.name === "cheers.openNative") {
    if (typeof ctx.uri === "string") requireThat(parseLocator(ctx.uri), "Invalid resource locator.");
    if (event.name === "cheers.openNative") {
      requireThat(["finder", "vscode", "zed"].includes(String(ctx.opener)), "This native opener is not supported.");
    }
  } else {
    if (event.name === "cheers.request" || event.name === "cheers.execute") {
      requireThat(typeof ctx.botId === "string" && UUID.test(ctx.botId), "Requests need a stable bot id.");
    }
    requireThat(typeof ctx.actionId === "string" && ACTION_ID.test(ctx.actionId), "Invalid compose action id.");
    requireThat(mapping(ctx.payload), "Compose payload must be an object.");
  }
}

function normalizeComponentList(components: unknown, legacy: boolean): Record<string, unknown>[] {
  requireThat(Array.isArray(components) && components.length <= 256, "Too many components.");
  const out: Record<string, unknown>[] = [];
  for (const rawComp of components) {
    requireThat(mapping(rawComp) && typeof rawComp.id === "string" && ID.test(rawComp.id), "Invalid component id.");
    const comp = (legacy ? rewriteLegacyPaths(rawComp) : { ...rawComp }) as Record<string, unknown>;
    if ("action" in comp) validateCheersAction(comp.action);
    if ("@checks" in comp) {
      // @a2ui/web_core@0.16.1's TextField/CheckBox schema wrapper rejects @checks at runtime;
      // strip @checks before feeding MessageProcessor while preserving document compatibility.
      delete comp["@checks"];
    }
    if (legacy && comp.component === "Button" && "label" in comp && !("child" in comp)) {
      const labelId = `${comp.id}__label`;
      out.push({ id: labelId, component: "Text", text: comp.label });
      const rest = { ...comp };
      delete rest.label;
      rest.child = labelId;
      out.push(rest);
      continue;
    }
    out.push(comp);
  }
  return out;
}

export interface NormalizedA2UIDocument {
  messages: ProcessableMessage[];
  views?: {
    minimal?: { surfaceId: string; root: string };
    medium?: { surfaceId: string; root: string };
  };
}

/** Validates the Cheers A2UI envelope and normalizes legacy catalog:v1/v2 documents
 * into standard A2UI 1.0 + Basic Catalog messages for `@a2ui/web_core`. */
export function normalizeA2UIDocument(raw: unknown): NormalizedA2UIDocument {
  requireThat(mapping(raw), "Expected an A2UI document.");
  keys(raw, ["a2ui", "messages", "views"]);
  requireThat(raw.a2ui === A2UI_VERSION || raw.a2ui === A2UI_VERSION_V1, "Unsupported A2UI version; expected 1.0 or v0.9.1.");
  const proto: ProtoVersion = raw.a2ui;
  requireThat(Array.isArray(raw.messages) && raw.messages.length <= 256, "Expected at most 256 A2UI messages.");
  const serialized = JSON.stringify(raw);
  requireThat(serialized.length <= 256_000, "A2UI document is too large.");
  safeJson(raw);

  const surfaceCatalogs = new Map<string, string>();
  const messages: ProcessableMessage[] = raw.messages.map((message) => {
    requireThat(mapping(message) && message.version === proto, `Every message must use ${proto}.`);
    const kinds = ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"].filter((key) => key in message);
    requireThat(kinds.length === 1, "Each message needs exactly one operation.");
    const kind = kinds[0];
    keys(message, ["version", kind]);
    const body = message[kind];
    requireThat(mapping(body) && typeof body.surfaceId === "string" && ID.test(body.surfaceId), "Invalid surface id.");

    if (kind === "createSurface") {
      const catalogId = String(body.catalogId ?? "");
      requireThat(A2UI_SUPPORTED_CATALOGS.has(catalogId), "This A2UI catalog is not supported.");
      if (proto === A2UI_VERSION && catalogId === A2UI_CATALOG_V1) {
        throw new Error("This A2UI catalog is not supported in 1.0.");
      }
      surfaceCatalogs.set(body.surfaceId, catalogId);
      const legacy = catalogId === A2UI_CATALOG_V1 || catalogId === A2UI_CATALOG_V2;
      const nextBody: Record<string, unknown> = {
        ...body,
        catalogId: legacy || catalogId === "https://a2ui.org/specification/v1_0/basic_catalog.json" ? basicCatalog.id : catalogId,
      };
      if (body.components !== undefined) {
        nextBody.components = normalizeComponentList(body.components, legacy);
      }
      return { version: "1.0", createSurface: nextBody } as unknown as ProcessableMessage;
    }

    const catalogId = surfaceCatalogs.get(body.surfaceId);
    requireThat(catalogId !== undefined, "A surface must be created before it is updated or deleted.");
    const legacy = catalogId === A2UI_CATALOG_V1 || catalogId === A2UI_CATALOG_V2;

    if (kind === "updateComponents") {
      return {
        version: "1.0",
        updateComponents: {
          surfaceId: body.surfaceId,
          components: normalizeComponentList(body.components, legacy),
        },
      } as unknown as ProcessableMessage;
    }
    if (kind === "updateDataModel") {
      const nextBody: Record<string, unknown> = { ...body };
      if (typeof nextBody.path === "string") pointerSegments(nextBody.path);
      return { version: "1.0", updateDataModel: nextBody } as unknown as ProcessableMessage;
    }
    return { version: "1.0", deleteSurface: { surfaceId: body.surfaceId } } as unknown as ProcessableMessage;
  });

  let views: NormalizedA2UIDocument["views"];
  if (raw.views !== undefined) {
    requireThat(mapping(raw.views), "Expected presentation views.");
    keys(raw.views, ["minimal", "medium"]);
    views = {};
    for (const [level, view] of Object.entries(raw.views)) {
      requireThat(mapping(view), "Invalid presentation view.");
      keys(view, ["surfaceId", "root"]);
      requireThat(typeof view.surfaceId === "string" && typeof view.root === "string", "Invalid presentation view.");
      views[level as "minimal" | "medium"] = { surfaceId: view.surfaceId, root: view.root };
    }
  }

  return { messages, views };
}

function applyPresentationView(
  doc: NormalizedA2UIDocument,
  level: "minimal" | "medium" | "max",
): ProcessableMessage[] {
  if (level === "max" || !doc.views?.[level]) return doc.messages;
  const target = doc.views[level]!;
  if (target.root === "root") return doc.messages;
  // Promote the selected view's root component to be rendered as "root" by A2uiSurface
  return doc.messages.map((msg) => {
    const m = msg as unknown as Record<string, unknown>;
    if ("createSurface" in m && mapping(m.createSurface) && m.createSurface.surfaceId === target.surfaceId && Array.isArray(m.createSurface.components)) {
      const comps = m.createSurface.components as Record<string, unknown>[];
      return {
        ...m,
        createSurface: {
          ...m.createSurface,
          components: [
            ...comps.filter((c) => c.id !== "root"),
            { id: "root", component: "Column", children: [target.root] },
          ],
        },
      } as unknown as ProcessableMessage;
    }
    return msg;
  });
}

export function createA2UIProcessor(
  raw: unknown,
  options?: { presentation?: "minimal" | "medium" | "max"; onAction?: ActionListener },
): { processor: MessageProcessor<ReactCatalogComponent>; surfaces: SurfaceModel<ReactCatalogComponent>[]; fits: boolean } {
  const normalized = normalizeA2UIDocument(raw);
  const fullProcessor = new MessageProcessor([cheersBasicCatalog], options?.onAction);
  const fullErrors = fullProcessor.processMessagesWithErrors(normalized.messages);
  if (fullErrors.length > 0) {
    fullProcessor.dispose();
    const first = fullErrors[0] as { message?: string; error?: { message?: string } };
    throw new Error(first.message ?? first.error?.message ?? "Invalid A2UI document.");
  }

  if (normalized.views) {
    for (const view of Object.values(normalized.views)) {
      if (!view) continue;
      const surface = fullProcessor.getSurface(view.surfaceId);
      requireThat(surface && surface.componentsModel.get(view.root), "Presentation view references a missing component.");
    }
  }

  const level = options?.presentation ?? "max";
  const viewSpec = level !== "max" ? normalized.views?.[level] : undefined;
  let activeProcessor = fullProcessor;
  if (viewSpec && viewSpec.root !== "root") {
    fullProcessor.dispose();
    activeProcessor = new MessageProcessor([cheersBasicCatalog], options?.onAction);
    const viewErrors = activeProcessor.processMessagesWithErrors(applyPresentationView(normalized, level));
    if (viewErrors.length > 0) {
      activeProcessor.dispose();
      throw new Error("Presentation view could not be rendered.");
    }
  }

  const allSurfaces = Array.from(activeProcessor.getSurfaces().values()) as SurfaceModel<ReactCatalogComponent>[];
  for (const surface of allSurfaces) {
    requireThat(surface.componentsModel.get("root"), "The surface needs a root component.");
  }
  const selected = viewSpec ? allSurfaces.filter((s) => s.id === viewSpec.surfaceId) : allSurfaces;
  const fits = level !== "minimal" || checkMinimalFits(selected);
  return { processor: activeProcessor, surfaces: selected, fits };
}

function checkMinimalFits(surfaces: SurfaceModel<ReactCatalogComponent>[]): boolean {
  if (surfaces.length > 1) return false;
  let nodes = 0;
  let fields = 0;
  let actions = 0;
  const visited = new Set<string>();
  for (const surface of surfaces) {
    const walk = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const comp = surface.componentsModel.get(id);
      if (!comp) return;
      nodes++;
      if (comp.type === "TextField" || comp.type === "CheckBox" || comp.type === "ChoicePicker" || comp.type === "Slider" || comp.type === "DateTimeInput") {
        fields++;
      }
      if (comp.type === "Button") actions++;
      const props = comp.properties as Record<string, unknown>;
      if (Array.isArray(props.children)) {
        for (const child of props.children) {
          if (typeof child === "string") walk(child);
        }
      }
      if (typeof props.child === "string") walk(props.child);
    };
    walk("root");
  }
  return nodes <= 16 && fields <= 3 && actions <= 2;
}

export function acceptsA2UIDocument(raw: unknown): boolean {
  try {
    const { processor, surfaces } = createA2UIProcessor(raw);
    processor.dispose();
    return surfaces.length > 0;
  } catch {
    return false;
  }
}
