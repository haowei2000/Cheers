import { unzipSync } from "fflate";
import type { TemplateManifest, ViewDef } from "../manifest";
import type { PluginMeta, RendererMatch } from "../sandbox/pluginManifest";

export const EXTENSION_MEDIA_TYPE = "application/vnd.cheers.extension+zip";
export const MAX_EXTENSION_COMPRESSED = 4 * 1024 * 1024;
export const MAX_EXTENSION_EXPANDED = 8 * 1024 * 1024;
export const MAX_EXTENSION_FILES = 128;
export const MAX_SEED_BYTES = 256 * 1024;

export interface ExtensionPermissions {
  fileWrite?: boolean;
  channelResources?: string[];
  navigationOpen?: boolean;
  composerPrefill?: boolean;
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
  match?: string[] | RendererMatch;
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
  rendererPlugin: PluginMeta | null;
  bytes: Uint8Array;
  sha256: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

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

/** Read the central directory before inflation so declared bombs, duplicates, encrypted
 * entries, and symlinks are rejected without allocating their expanded contents. */
function inspectZip(bytes: Uint8Array): void {
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
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Invalid ZIP central directory");
    }
    const flags = view.getUint16(offset + 8, true);
    if (flags & 1) throw new Error("Encrypted ZIP entries are not supported");
    expanded += view.getUint32(offset + 24, true);
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
    offset = nameStart + nameLength + extraLength + commentLength;
  }
}

function requireId(kind: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`Invalid ${kind} id`);
}

function parseManifest(bytes: Uint8Array): ExtensionManifest {
  const manifest = JSON.parse(text(bytes, "manifest.json")) as ExtensionManifest;
  if (manifest.schemaVersion !== 1) throw new Error("manifest schemaVersion must be 1");
  requireId("extension", manifest.id);
  if (!SEMVER.test(manifest.version)) throw new Error("manifest version must be SemVer");
  if (typeof manifest.title !== "string" || !manifest.title.trim()) throw new Error("manifest title is required");
  if (!manifest.contributes || typeof manifest.contributes !== "object") throw new Error("manifest contributes is required");
  const sceneIds = new Set<string>();
  for (const scene of manifest.contributes.scenes ?? []) {
    requireId("scene", scene.id);
    if (sceneIds.has(scene.id)) throw new Error(`Duplicate scene id: ${scene.id}`);
    sceneIds.add(scene.id);
    if (scene.definition !== `scenes/${scene.id}.json`) throw new Error(`Non-canonical scene path: ${scene.id}`);
  }
  const rendererIds = new Set<string>();
  for (const renderer of manifest.contributes.renderers ?? []) {
    requireId("renderer", renderer.id);
    if (rendererIds.has(renderer.id)) throw new Error(`Duplicate renderer id: ${renderer.id}`);
    rendererIds.add(renderer.id);
    if (renderer.entry !== `renderers/${renderer.id}.js`) throw new Error(`Non-canonical renderer path: ${renderer.id}`);
    if (renderer.style && renderer.style !== `renderers/${renderer.id}.css`) throw new Error(`Non-canonical renderer style: ${renderer.id}`);
  }
  const allowedResources = new Set(["channel.info", "channel.members", "channel.messages", "channel.activity.read", "channel.messages.index"]);
  for (const resource of manifest.permissions?.channelResources ?? []) {
    if (!allowedResources.has(resource)) throw new Error(`Channel resource is not allowed: ${resource}`);
  }
  if (manifest.permissions?.network !== undefined && manifest.permissions.network !== "unrestricted") {
    throw new Error("network may only be omitted or set to unrestricted");
  }
  return manifest;
}

function hasCode(manifest: ExtensionManifest): boolean {
  const p = manifest.permissions ?? {};
  return (
    (manifest.contributes.renderers?.length ?? 0) > 0 ||
    !!p.fileWrite ||
    !!p.channelResources?.length ||
    !!p.navigationOpen ||
    !!p.composerPrefill ||
    p.network !== undefined
  );
}

async function digest(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes).buffer;
  const hash = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function parseExtensionPackage(
  input: ArrayBuffer | Uint8Array,
  scope: "global" | "personal" | "temporary"
): Promise<ParsedExtension> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  inspectZip(bytes);
  const files = unzipSync(bytes);
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
    if (!Array.isArray(definition.items)) throw new Error(`Scene ${contribution.id} items must be an array`);
    const views: ViewDef[] = definition.items.map((item) => {
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
    for (const ref of definition.seed ?? []) {
      if (!ref.source.startsWith(`seed/${contribution.id}/`)) throw new Error(`Invalid seed source: ${ref.source}`);
      const content = files[ref.source];
      if (!content) throw new Error(`Missing seed source: ${ref.source}`);
      if (content.byteLength > MAX_SEED_BYTES) throw new Error(`Seed file exceeds 256 KiB: ${ref.source}`);
      seed[ref.path] = text(content, ref.source);
    }
    scenes.push({
      id: `${scope === "global" ? "extension" : "personal"}:${manifest.id}:${contribution.id}`,
      title: contribution.title,
      views,
      seed,
      pin: definition.pin ?? [],
    });
  }

  const renderers = manifest.contributes.renderers ?? [];
  const rendererPlugin: PluginMeta | null = renderers.length
    ? {
        plugin_id: manifest.id,
        title: manifest.title,
        manifest: { renderers, permissions: manifest.permissions ?? {} },
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
  return { manifest, scenes, rendererPlugin, bytes, sha256: await digest(bytes) };
}

export function permissionSummary(manifest: ExtensionManifest): string[] {
  const p = manifest.permissions ?? {};
  return [
    p.fileWrite && "Write file",
    p.channelResources?.length && `Read channel (${p.channelResources.length})`,
    p.navigationOpen && "Open navigation",
    p.composerPrefill && "Prefill composer",
    p.network === "unrestricted" && "Unrestricted network",
  ].filter((value): value is string => Boolean(value));
}
