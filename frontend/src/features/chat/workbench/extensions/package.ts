import { inflateSync } from "fflate";
import type { TemplateManifest, ViewDef } from "../manifest";
import type { RendererExtension } from "../sandbox/rendererExtension";

export const EXTENSION_MEDIA_TYPE = "application/vnd.cheers.extension+zip";
export const MAX_EXTENSION_COMPRESSED = 4 * 1024 * 1024;
export const MAX_EXTENSION_EXPANDED = 8 * 1024 * 1024;
export const MAX_EXTENSION_FILES = 128;
export const MAX_SEED_BYTES = 256 * 1024;

export interface ExtensionPermissions {
  "file.write"?: boolean;
  "channel.resources"?: string[];
  "navigation.open"?: boolean;
  "composer.prefill"?: boolean;
  "automation.manage"?: boolean;
  network?: "unrestricted";
}

export interface SceneContribution {
  id: string;
  title: string;
  definition: string;
}

export interface RendererContribution {
  id: string;
  title: string;
  entry: string;
  style?: string;
  match?: string[];
}

export interface AutomationContribution {
  id: string;
  title: string;
  description?: string;
  message: string;
  defaultSchedule:
    | { kind: "interval"; everyMinutes: number }
    | { kind: "daily"; localTime: string; timezone?: string };
}

export interface ExtensionManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  title: string;
  description?: string;
  contributes: {
    scenes?: SceneContribution[];
    renderers?: RendererContribution[];
    automations?: AutomationContribution[];
  };
  permissions?: ExtensionPermissions;
}

interface PackageSceneDefinition {
  items: Array<{
    id: string;
    title: string;
    file: string;
    renderer?: string;
    config?: unknown;
  }>;
  seed?: Array<{ path: string; source: string }>;
  pin?: string[];
}

export interface ParsedExtension {
  manifest: ExtensionManifest;
  scenes: TemplateManifest[];
  rendererExtension: RendererExtension | null;
  bytes: Uint8Array;
  sha256: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function requireObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function requireKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !known.has(key));
  if (unknown) throw new Error(`${label} contains unknown field: ${unknown}`);
}

function validateWorkspacePath(path: unknown, label: string): asserts path is string {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") || path.includes("..")) {
    throw new Error(`Unsafe workspace path: ${label}`);
  }
}

function text(bytes: Uint8Array, name: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`${name} must be UTF-8`);
  }
}

function validatePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
    throw new Error(`Unsafe ZIP path: ${path}`);
  }
  const known =
    path === "manifest.json" ||
    (path.startsWith("scenes/") && path.endsWith(".json")) ||
    path.startsWith("seed/") ||
    (path.startsWith("renderers/") && (path.endsWith(".js") || path.endsWith(".css")));
  if (!known) throw new Error(`Unknown or executable file is not allowed: ${path}`);
}

interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. Nothing else is accepted. */
  method: number;
  compressedSize: number;
  /** What the central directory claims this entry expands to. A claim, not a fact —
   * see {@link readEntries}. */
  declaredSize: number;
  /** Byte offset of this entry's local file header. */
  localOffset: number;
}

/** Read the central directory before inflation so declared bombs, duplicates, encrypted
 * entries, and symlinks are rejected without allocating their expanded contents.
 * Returns the entry table so {@link readEntries} can inflate one entry at a time. */
function inspectZip(bytes: Uint8Array): ZipEntry[] {
  if (bytes.byteLength > MAX_EXTENSION_COMPRESSED) throw new Error("Extension exceeds 4 MiB");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP archive");
  const count = view.getUint16(eocd + 10, true);
  if (count > MAX_EXTENSION_FILES) throw new Error("Extension contains more than 128 files");
  let offset = view.getUint32(eocd + 16, true);
  let expanded = 0;
  const names = new Set<string>();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Invalid ZIP central directory");
    }
    const flags = view.getUint16(offset + 8, true);
    if (flags & 1) throw new Error("Encrypted ZIP entries are not supported");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const declaredSize = view.getUint32(offset + 24, true);
    const localOffset = view.getUint32(offset + 42, true);
    // 0xffffffff is ZIP64's "look in the extra field" sentinel. A 4 MiB package
    // can never legitimately need it, and silently reading the sentinel as a
    // size is how a ZIP64 archive gets parsed two different ways.
    if (compressedSize === 0xffffffff || declaredSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("ZIP64 extensions are not supported");
    }
    // Now that every entry is checked against its declaration, this cap is a
    // bound on the real expanded size rather than on a number chosen by whoever
    // built the archive.
    expanded += declaredSize;
    if (expanded > MAX_EXTENSION_EXPANDED) throw new Error("Extension exceeds 8 MiB expanded");
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const nameStart = offset + 46;
    const name = text(bytes.subarray(nameStart, nameStart + nameLength), "ZIP path");
    validatePath(name);
    if (names.has(name)) throw new Error(`Duplicate ZIP path: ${name}`);
    names.add(name);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000) throw new Error(`Symbolic link is not allowed: ${name}`);
    entries.push({ name, method, compressedSize, declaredSize, localOffset });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Inflate every entry, holding each one to the size its central directory declared.
 *
 * The declared size is attacker-chosen and independent of the deflate stream, and
 * `unzipSync` trusts it: it allocates exactly that many bytes and silently discards
 * everything the stream produces past the end. A package declaring 200 bytes whose
 * stream inflates to 5013 therefore yields 200 bytes here and all 5013 in the Rust
 * validator, which reads the real stream — the same bytes and the same sha256
 * producing two different extensions. Truncated JSON usually gives itself away by
 * failing to parse; truncated `renderers/*.js` is still valid JavaScript, and
 * truncated `seed/*` reaches the workspace with no signal at all.
 *
 * So each entry is inflated into a buffer one byte larger than declared. fflate
 * truncates to the buffer it is given, so a result that fills it proves the stream
 * produced more than the archive claimed, and any other mismatch means the
 * declaration was wrong in the other direction. Either way the two parsers would
 * disagree, so the package is rejected rather than interpreted. */
function readEntries(bytes: Uint8Array, entries: ZipEntry[]): Record<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;
    if (entry.localOffset + 30 > bytes.byteLength || view.getUint32(entry.localOffset, true) !== 0x04034b50) {
      throw new Error(`Invalid ZIP local header: ${entry.name}`);
    }
    // Name and extra lengths are read from the LOCAL header, not the central one:
    // the two copies are permitted to differ, and the entry's data begins after
    // the local copy.
    const start = entry.localOffset + 30 + view.getUint16(entry.localOffset + 26, true) + view.getUint16(entry.localOffset + 28, true);
    const end = start + entry.compressedSize;
    if (end > bytes.byteLength) throw new Error(`Truncated ZIP entry: ${entry.name}`);
    const compressed = bytes.subarray(start, end);
    let content: Uint8Array;
    if (entry.method === 0) {
      content = compressed;
    } else if (entry.method === 8) {
      content = inflateSync(compressed, { out: new Uint8Array(entry.declaredSize + 1) });
    } else {
      throw new Error(`Unsupported ZIP compression method for ${entry.name}`);
    }
    if (content.length !== entry.declaredSize) {
      throw new Error(`ZIP entry does not match its declared size: ${entry.name}`);
    }
    files[entry.name] = content;
  }
  return files;
}

function requireId(kind: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`Invalid ${kind} id`);
}

function parseManifest(bytes: Uint8Array): ExtensionManifest {
  const manifest = JSON.parse(text(bytes, "manifest.json")) as ExtensionManifest;
  requireObject(manifest, "manifest");
  requireKnownKeys(manifest, ["schemaVersion", "id", "version", "title", "description", "contributes", "permissions"], "manifest");
  if (manifest.schemaVersion !== 1) throw new Error("manifest schemaVersion must be 1");
  requireId("extension", manifest.id);
  if (!SEMVER.test(manifest.version)) throw new Error("manifest version must be SemVer");
  if (typeof manifest.title !== "string" || !manifest.title.trim()) throw new Error("manifest title is required");
  if (!manifest.contributes || typeof manifest.contributes !== "object") throw new Error("manifest contributes is required");
  requireObject(manifest.contributes, "manifest contributes");
  requireKnownKeys(manifest.contributes, ["scenes", "renderers", "automations"], "manifest contributes");
  if (manifest.contributes.scenes !== undefined && !Array.isArray(manifest.contributes.scenes)) throw new Error("manifest scenes must be an array");
  if (manifest.contributes.renderers !== undefined && !Array.isArray(manifest.contributes.renderers)) throw new Error("manifest renderers must be an array");
  if (manifest.contributes.automations !== undefined && !Array.isArray(manifest.contributes.automations)) throw new Error("manifest automations must be an array");
  const sceneIds = new Set<string>();
  for (const scene of manifest.contributes.scenes ?? []) {
    requireObject(scene, "scene contribution");
    requireKnownKeys(scene, ["id", "title", "definition"], "scene contribution");
    requireId("scene", scene.id);
    if (typeof scene.title !== "string" || !scene.title.trim()) throw new Error(`Scene title is required: ${scene.id}`);
    if (sceneIds.has(scene.id)) throw new Error(`Duplicate scene id: ${scene.id}`);
    sceneIds.add(scene.id);
    if (scene.definition !== `scenes/${scene.id}.json`) throw new Error(`Non-canonical scene path: ${scene.id}`);
  }
  const rendererIds = new Set<string>();
  for (const renderer of manifest.contributes.renderers ?? []) {
    requireObject(renderer, "renderer contribution");
    requireKnownKeys(renderer, ["id", "title", "entry", "style", "match"], "renderer contribution");
    requireId("renderer", renderer.id);
    if (typeof renderer.title !== "string" || !renderer.title.trim()) throw new Error(`Renderer title is required: ${renderer.id}`);
    if (rendererIds.has(renderer.id)) throw new Error(`Duplicate renderer id: ${renderer.id}`);
    rendererIds.add(renderer.id);
    if (renderer.entry !== `renderers/${renderer.id}.js`) throw new Error(`Non-canonical renderer path: ${renderer.id}`);
    if (renderer.style && renderer.style !== `renderers/${renderer.id}.css`) throw new Error(`Non-canonical renderer style: ${renderer.id}`);
    if (renderer.match !== undefined && (!Array.isArray(renderer.match) || renderer.match.some((glob) => typeof glob !== "string" || !glob.trim()))) {
      throw new Error(`Invalid renderer match: ${renderer.id}`);
    }
  }
  const automationIds = new Set<string>();
  for (const automation of manifest.contributes.automations ?? []) {
    requireObject(automation, "automation contribution");
    requireKnownKeys(automation, ["id", "title", "description", "message", "defaultSchedule"], "automation contribution");
    requireId("automation", automation.id);
    if (automationIds.has(automation.id)) throw new Error(`Duplicate automation id: ${automation.id}`);
    automationIds.add(automation.id);
    if (typeof automation.title !== "string" || !automation.title.trim() || automation.title.length > 120) {
      throw new Error(`Invalid automation title: ${automation.id}`);
    }
    if (typeof automation.message !== "string" || !automation.message.trim() || automation.message.length > 4000) {
      throw new Error(`Invalid automation message: ${automation.id}`);
    }
    const schedule = automation.defaultSchedule;
    requireObject(schedule, `automation schedule: ${automation.id}`);
    requireKnownKeys(schedule, ["kind", "everyMinutes", "localTime", "timezone"], `automation schedule: ${automation.id}`);
    const validInterval = schedule?.kind === "interval" && Number.isInteger(schedule.everyMinutes) && schedule.everyMinutes >= 5 && schedule.everyMinutes <= 10080;
    const validDaily = schedule?.kind === "daily" && /^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.localTime) && (schedule.timezone === undefined || (schedule.timezone.trim().length > 0 && schedule.timezone.length <= 64));
    if (!validInterval && !validDaily) {
      throw new Error(`Invalid automation schedule: ${automation.id}`);
    }
  }
  const allowedResources = new Set(["channel.info", "channel.members", "channel.messages", "channel.activity.read", "channel.messages.index"]);
  requireObject(manifest.permissions ?? {}, "manifest permissions");
  const permissionKeys = new Set(["file.write", "channel.resources", "navigation.open", "composer.prefill", "automation.manage", "network"]);
  for (const key of Object.keys(manifest.permissions ?? {})) {
    if (!permissionKeys.has(key)) throw new Error(`Unknown permission: ${key}`);
  }
  for (const key of ["file.write", "navigation.open", "composer.prefill", "automation.manage"] as const) {
    const value = manifest.permissions?.[key];
    if (value !== undefined && typeof value !== "boolean") throw new Error(`${key} must be boolean`);
  }
  if (manifest.permissions?.["channel.resources"] !== undefined && !Array.isArray(manifest.permissions["channel.resources"])) {
    throw new Error("channel.resources must be an array");
  }
  for (const resource of manifest.permissions?.["channel.resources"] ?? []) {
    if (!allowedResources.has(resource)) throw new Error(`Channel resource is not allowed: ${resource}`);
  }
  if (manifest.permissions?.network !== undefined && manifest.permissions.network !== "unrestricted") {
    throw new Error("network may only be omitted or set to unrestricted");
  }
  return manifest;
}

/** True when the package would run code or hold a permission.
 *
 * One predicate, two uses that mean the same thing: it is what makes a package
 * ineligible for global scope — the server stores no code and grants no
 * permission — and therefore what a temporary, session-only load has to ask
 * about before activating. */
export function hasCode(manifest: ExtensionManifest): boolean {
  const p = manifest.permissions ?? {};
  return (
    (manifest.contributes.renderers?.length ?? 0) > 0 ||
    !!p["file.write"] ||
    !!p["channel.resources"]?.length ||
    !!p["navigation.open"] ||
    !!p["composer.prefill"] ||
    !!p["automation.manage"] ||
    p.network !== undefined
  );
}

async function digest(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes).buffer;
  const hash = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** Validate and unpack a `.cheers-extension`.
 *
 * Application code should call `parseExtensionPackageOffThread` instead: inflation
 * has no cheap upper bound, so this must not run on the main thread. This export
 * is the parser itself — what the worker runs, and what the tests exercise. */
export async function parseExtensionPackage(
  input: ArrayBuffer | Uint8Array,
  scope: "global" | "personal" | "temporary"
): Promise<ParsedExtension> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const files = readEntries(bytes, inspectZip(bytes));
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw new Error("Extension is missing manifest.json");
  const manifest = parseManifest(manifestBytes);
  if (scope === "global" && hasCode(manifest)) {
    throw new Error("Browser/global extensions must be declarative and cannot contain renderer code");
  }
  for (const renderer of manifest.contributes.renderers ?? []) {
    if (!files[renderer.entry]) throw new Error(`Missing renderer entry: ${renderer.entry}`);
    if (renderer.style && !files[renderer.style]) throw new Error(`Missing renderer style: ${renderer.style}`);
  }

  const scenes: TemplateManifest[] = [];
  for (const contribution of manifest.contributes.scenes ?? []) {
    const sceneBytes = files[contribution.definition];
    if (!sceneBytes) throw new Error(`Missing scene definition: ${contribution.definition}`);
    const definition = JSON.parse(text(sceneBytes, contribution.definition)) as PackageSceneDefinition;
    requireObject(definition, `scene ${contribution.id}`);
    requireKnownKeys(definition, ["items", "seed", "pin"], `scene ${contribution.id}`);
    if (!Array.isArray(definition.items)) throw new Error(`Scene ${contribution.id} items must be an array`);
    const itemIds = new Set<string>();
    const views: ViewDef[] = definition.items.map((item) => {
      requireObject(item, `scene item in ${contribution.id}`);
      requireKnownKeys(item, ["id", "title", "file", "renderer", "config"], `scene item in ${contribution.id}`);
      requireId("scene item", item.id);
      if (itemIds.has(item.id)) throw new Error(`Duplicate scene item id: ${item.id}`);
      itemIds.add(item.id);
      if (typeof item.title !== "string" || !item.title.trim()) throw new Error(`Scene item title is required: ${item.id}`);
      validateWorkspacePath(item.file, `${contribution.id}/${item.id}`);
      const renderer = item.renderer ?? "auto";
      const selfId = renderer.startsWith("self:") ? renderer.slice(5) : null;
      if (!(renderer === "auto" || renderer.startsWith("builtin:") || (scope !== "global" && selfId && manifest.contributes.renderers?.some((candidate) => candidate.id === selfId)))) {
        throw new Error(`Unsupported renderer reference: ${renderer}`);
      }
      return {
        id: item.id,
        title: item.title,
        file: item.file,
        lens: renderer.startsWith("builtin:") ? renderer.slice(8) : "markdown",
        renderer: renderer.startsWith("self:") ? `personal:${manifest.id}:${renderer.slice(5)}` : renderer,
        config: item.config,
      };
    });
    const seed: Record<string, string> = {};
    const seedPaths = new Set<string>();
    if (definition.seed !== undefined && !Array.isArray(definition.seed)) throw new Error(`Scene ${contribution.id} seed must be an array`);
    for (const ref of definition.seed ?? []) {
      requireObject(ref, `seed reference in ${contribution.id}`);
      requireKnownKeys(ref, ["path", "source"], `seed reference in ${contribution.id}`);
      validateWorkspacePath(ref.path, `${contribution.id} seed`);
      if (seedPaths.has(ref.path)) throw new Error(`Duplicate seed path: ${ref.path}`);
      seedPaths.add(ref.path);
      if (!ref.source.startsWith(`seed/${contribution.id}/`)) throw new Error(`Invalid seed source: ${ref.source}`);
      const content = files[ref.source];
      if (!content) throw new Error(`Missing seed source: ${ref.source}`);
      if (content.byteLength > MAX_SEED_BYTES) throw new Error(`Seed file exceeds 256 KiB: ${ref.source}`);
      seed[ref.path] = text(content, ref.source);
    }
    if (definition.pin !== undefined && !Array.isArray(definition.pin)) throw new Error(`Scene ${contribution.id} pin must be an array`);
    for (const path of definition.pin ?? []) validateWorkspacePath(path, `${contribution.id} pin`);
    scenes.push({
      id: `${scope === "global" ? "extension" : "personal"}:${manifest.id}:${contribution.id}`,
      title: contribution.title,
      views,
      seed,
      pin: definition.pin ?? [],
    });
  }

  const renderers = manifest.contributes.renderers ?? [];
  const rendererExtension: RendererExtension | null = renderers.length
    ? {
        extensionId: manifest.id,
        title: manifest.title,
        manifest: {
          renderers,
          automations: (manifest.contributes.automations ?? []).map(({ id, title }) => ({ id, title })),
          permissions: manifest.permissions ?? {},
        },
        origin: scope === "temporary" ? "temporary" : "personal",
        assets: Object.fromEntries(
          renderers.flatMap((renderer) => [
            [renderer.entry, text(files[renderer.entry] ?? new Uint8Array(), renderer.entry)],
            ...(renderer.style ? [[renderer.style, text(files[renderer.style] ?? new Uint8Array(), renderer.style)] as [string, string]] : []),
          ])
        ),
        transient: scope === "temporary",
      }
    : null;
  return { manifest, scenes, rendererExtension, bytes, sha256: await digest(bytes) };
}

export function permissionSummary(manifest: ExtensionManifest): string[] {
  const p = manifest.permissions ?? {};
  return [
    p["file.write"] && "Write file",
    p["channel.resources"]?.length && `Read channel (${p["channel.resources"].length})`,
    p["navigation.open"] && "Open navigation",
    p["composer.prefill"] && "Prefill composer",
    p["automation.manage"] && "Manage scheduled tasks",
    p.network === "unrestricted" && "Unrestricted network",
  ].filter((value): value is string => Boolean(value));
}
