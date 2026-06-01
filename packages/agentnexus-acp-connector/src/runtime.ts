import {
  createHash,
  createPrivateKey,
  randomUUID,
  sign as cryptoSign,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BotSession,
  type AttachmentInfo,
  type AcpCapabilityEnvelope,
  type AcpSecurityHello,
  type ConfigOptionSetInbound,
  type ConfigUpdateInbound,
  type InboundMessage,
  type PermissionResolutionInbound,
} from "@haowei0520/bridge-client";

import { JsonRpcError, JsonRpcRequestTimeoutError } from "./acp-jsonrpc.js";
import { AcpStdioAgent } from "./acp-agent.js";
import { SessionStateStore } from "./state.js";
import type {
  AcpCapabilityConfig,
  AccountConfig,
  AcpConfigOption,
  AcpConfigOptionValue,
  AcpSessionUpdate,
  ContentBlock,
  Logger,
  PermissionMode,
  RemoteConnectorSettings,
} from "./types.js";

interface ExtractedFile {
  key: string;
  filename: string;
  contentType?: string;
  data: Uint8Array;
  path?: string;
}

interface PromptBuildOptions {
  httpBase: string;
  botToken: string;
  cwd: string;
  taskId: string;
  supportsImages: boolean;
  supportsEmbeddedContext: boolean;
  logger: Logger;
  ignoreOutputFileKey?: (fileKey: string) => void;
}

interface BridgeTextFile {
  filename: string;
  contentType: string;
  sizeBytes?: number;
  summary?: string;
  content: string;
  truncated: boolean;
}

interface BridgeBinaryFile {
  filename: string;
  contentType: string;
  sizeBytes?: number;
  dataB64: string;
}

type AgentNexusAttachment = AttachmentInfo & {
  is_image?: string | boolean | null;
  image_b64?: string | null;
};

interface LocalAttachmentFile {
  filename: string;
  contentType: string;
  sizeBytes?: number;
  path: string;
  uri: string;
}

interface BridgeUploadedFile {
  file_id: string;
  filename: string;
  content_type?: string;
  size_bytes?: number;
  preview_url?: string;
  download_url?: string;
}

interface AcpCapabilitySigner {
  sign(frame: OutboundAcpDataFrame): AcpCapabilityEnvelope;
}

interface OutboundAcpDataFrame {
  type: string;
  acp_capability?: AcpCapabilityEnvelope;
  [key: string]: unknown;
}

type CanonicalValue = null | boolean | number | string | CanonicalRecord | CanonicalValue[];

interface CanonicalRecord {
  [key: string]: CanonicalValue;
}

const ACP_CAPABILITY_SIGNED_FRAME_TYPES = new Set([
  "send",
  "delta",
  "done",
  "resource_req",
  "session_update",
  "permission_request",
  "trace",
]);
const ACP_CAPABILITY_SUPPORTED_ALGORITHM = "ed25519";

function readTextFileIfPrefixed(pathRef: string): string {
  const trimmed = pathRef.trim();
  if (!trimmed.startsWith("file:")) return trimmed;
  const rawPath = trimmed.slice(5).trim();
  const envExpandedPath = rawPath.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, name: string) => process.env[name] ?? "");
  const envExpandedSimple = /^\$[A-Za-z0-9_]+$/.test(envExpandedPath)
    ? process.env[envExpandedPath.slice(1)] ?? ""
    : envExpandedPath;
  const finalPath = path.resolve(envExpandedSimple);
  return readFileSync(finalPath, "utf8");
}

function canonicalSerialize(value: CanonicalValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    try {
      return JSON.stringify(value);
    } catch {
      return "\"\"";
    }
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSerialize).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalSerialize(item)}`).join(",")}}`;
}

function frameForSignature(frame: OutboundAcpDataFrame): CanonicalRecord {
  const copied = JSON.parse(JSON.stringify(frame)) as CanonicalValue;
  if (copied && typeof copied === "object" && !Array.isArray(copied)) {
    delete (copied as CanonicalRecord).acp_capability;
    return copied as CanonicalRecord;
  }
  return {};
}

function frameNeedsAcpCapability(type: string): boolean {
  return ACP_CAPABILITY_SIGNED_FRAME_TYPES.has(type);
}

function buildCapabilityPayload(
  frameType: string,
  delegationId: string,
  ts: number,
  nonce: string,
  requestId: string,
  sanitizedFrame: CanonicalValue,
): string {
  return `anx-cap|v1|type=${frameType}|kid=${delegationId}|ts=${ts}|nonce=${nonce}|request=${requestId}|payload=${canonicalSerialize(sanitizedFrame)}`;
}

function buildAcpCapabilitySigner(config: AcpCapabilityConfig): AcpCapabilitySigner {
  const algorithm = (config.algorithm ?? ACP_CAPABILITY_SUPPORTED_ALGORITHM).toLowerCase();
  if (algorithm !== ACP_CAPABILITY_SUPPORTED_ALGORITHM) {
    throw new Error(`unsupported acp capability algorithm: ${algorithm}`);
  }

  const privateKeyText = readTextFileIfPrefixed(config.privateKey);
  if (!privateKeyText.trim()) {
    throw new Error(`account ${config.delegationId} has empty acp private_key`);
  }

  const privateKey = createPrivateKey(privateKeyText);
  const requestIdPrefix = (config.requestIdPrefix && config.requestIdPrefix.trim())
    ? config.requestIdPrefix.trim()
    : "acp-cap";
  let requestSeq = 0;

  return {
    sign(frame: OutboundAcpDataFrame): AcpCapabilityEnvelope {
      const ts = Math.floor(Date.now() / 1000);
      const nonce = randomUUID();
      const requestId = `${requestIdPrefix}-${ts}-${++requestSeq}`;
      const payload = frameForSignature(frame);
      const data = buildCapabilityPayload(frame.type, config.delegationId, ts, nonce, requestId, payload);
      const signature = cryptoSign(null, Buffer.from(data, "utf8"), privateKey).toString("base64");
      return {
        delegation_id: config.delegationId,
        ts,
        nonce,
        request_id: requestId,
        signature,
        algorithm,
        kid: config.kid,
      };
    },
  };
}

class BridgeHttpUploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BridgeHttpUploadError";
  }
}

interface RunContext {
  source: InboundMessage;
  providerSessionKey: string;
  sourceSessionId?: string;
  acpSessionId: string;
  msgId: string;
  httpBase: string;
  botToken: string;
  startedAtMs: number;
  deltaSeq: number;
  traceSeq: number;
  text: string;
  sentDelta: boolean;
  fileIds: string[];
  seenFileKeys: Set<string>;
  ignoredOutputFileKeys: Set<string>;
  pendingFileUploads: Promise<void>[];
}

interface SettingsApplyResult {
  applied: string[];
  rejected: Array<{ field: string; reason: string }>;
  settings: RemoteConnectorSettings;
}

interface PermissionOption {
  option_id: string;
  kind?: string;
  name?: string;
  description?: string;
}

interface PendingPermissionRequest {
  ctx: RunContext;
  params: unknown;
  resolve: (outcome: AcpPermissionOutcome) => void;
  timer: NodeJS.Timeout;
}

type AcpPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

interface AcpDiscoveredOptions {
  source: "acp";
  agentInfo?: unknown;
  agentCapabilities?: unknown;
  sessionId?: string | null;
  providerSessionKey?: string | null;
  modes?: unknown;
  configOptions?: unknown;
  availableCommands?: unknown;
  updatedAt: string;
  [key: string]: unknown;
}

const REMOTE_TIMEOUT_MIN_MS = 5_000;
const REMOTE_TIMEOUT_MAX_MS = 3_600_000;
const REMOTE_MODEL_MAX_LENGTH = 128;
const OUTPUT_FILE_EXTENSIONS = new Set([
  ".7z",
  ".bz2",
  ".csv",
  ".doc",
  ".docx",
  ".dps",
  ".dwg",
  ".dxf",
  ".epub",
  ".et",
  ".gif",
  ".gz",
  ".htm",
  ".html",
  ".jpeg",
  ".jpg",
  ".json",
  ".md",
  ".ofd",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".rar",
  ".rtf",
  ".svg",
  ".tar",
  ".tgz",
  ".txt",
  ".webp",
  ".wps",
  ".xls",
  ".xlsx",
  ".xml",
  ".zip",
]);
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  ".docx",
  ".htm",
  ".html",
  ".md",
  ".pdf",
  ".txt",
  ".xlsx",
]);
const TEXT_ATTACHMENT_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/html",
  "text/markdown",
  "text/plain",
]);
const FILE_REFERENCE_FIELDS = [
  "uri",
  "url",
  "path",
  "filePath",
  "filepath",
  "absolutePath",
  "localPath",
];
const NESTED_CONTENT_FIELDS = [
  "content",
  "contents",
  "resource",
  "resources",
  "attachment",
  "attachments",
  "artifact",
  "artifacts",
  "file",
  "files",
  "output",
  "outputs",
  "item",
  "items",
];
const TEXT_REFERENCE_FIELDS = ["text", "message", "markdown", "description"];
const AGENTNEXUS_ACP_OUTPUT_CONTRACT = [
  "AgentNexus ACP output contract:",
  "- Return generated images or files as ACP resource/file content with inline text/base64, or write them under the current working directory and include a Markdown/file path link.",
  "- Do not return provider-internal item ids such as OpenAI `ig_...`; AgentNexus cannot fetch those ids as files.",
].join("\n");

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textOfContent(content: unknown): string {
  if (Array.isArray(content)) return content.map(textOfContent).filter(Boolean).join("");
  if (!content || typeof content !== "object") return "";
  const c = content as Record<string, unknown>;
  if (c.type === "text" && typeof c.text === "string") return c.text;
  if (c.type === "content") return textOfContent(c.content);
  if (Array.isArray(c.content)) return textOfContent(c.content);
  return "";
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function capArray(value: unknown, max: number): unknown {
  return Array.isArray(value) ? value.slice(0, max) : value;
}

function normalizeDiscoveredOptions(options: AcpDiscoveredOptions): Record<string, unknown> {
  const next: Record<string, unknown> = { ...options };
  if (isObject(next.modes)) {
    next.modes = {
      ...next.modes,
      availableModes: capArray(next.modes["availableModes"], 50),
    };
  }
  if (hasOwn(next, "configOptions")) next.configOptions = capArray(normalizeAcpConfigOptions(next.configOptions), 100);
  if (hasOwn(next, "availableCommands")) next.availableCommands = capArray(next.availableCommands, 100);
  return next;
}

function cleanConfigText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeAcpConfigOptionValues(value: unknown): AcpConfigOptionValue[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isObject)
    .map((item) => {
      const optionValue = cleanConfigText(item.value, cleanConfigText(item.id));
      if (!optionValue) return null;
      return {
        ...item,
        value: optionValue,
        name: cleanConfigText(item.name, optionValue),
      };
    })
    .filter((item): item is AcpConfigOptionValue => item !== null);
}

function normalizeAcpConfigOptions(value: unknown): AcpConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isObject)
    .map((item) => {
      const id = cleanConfigText(item.id);
      if (!id) return null;
      const rawOptions = Array.isArray(item.options) ? item.options : item.values;
      return {
        ...item,
        id,
        name: cleanConfigText(item.name, id),
        type: cleanConfigText(item.type, "select"),
        currentValue: cleanConfigText(item.currentValue, cleanConfigText(item.currentValueId)),
        options: normalizeAcpConfigOptionValues(rawOptions),
      };
    })
    .filter((item): item is AcpConfigOption => item !== null);
}

function acpConfigOptionsKey(options: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(options)
      .map(([key, value]) => [key.trim(), value.trim()])
      .filter(([key, value]) => key && value)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function safeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ()\[\]\u4e00-\u9fff]/g, "_");
  return base && base !== "." && base !== ".." ? base : "acp-output.bin";
}

function filenameFromUri(uri: string): string {
  if (uri.startsWith("file://")) return safeFilename(fileURLToPath(uri));
  try {
    const parsed = new URL(uri);
    return safeFilename(decodeURIComponent(path.basename(parsed.pathname)));
  } catch {
    return safeFilename(uri);
  }
}

function guessContentType(filename: string, fallback?: string): string | undefined {
  const cleanFallback = fallback?.split(";")[0]?.trim();
  if (cleanFallback) return cleanFallback;
  const ext = path.extname(filename).toLowerCase();
  const types: Record<string, string> = {
    ".7z": "application/x-7z-compressed",
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".gz": "application/gzip",
    ".htm": "text/html",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".rar": "application/vnd.rar",
    ".svg": "image/svg+xml",
    ".tar": "application/x-tar",
    ".tgz": "application/gzip",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xml": "application/xml",
    ".zip": "application/zip",
  };
  return types[ext] ?? undefined;
}

function contentTypeFromDataUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  const match = /^data:([^;,]+)?;base64,/i.exec(value);
  return match?.[1]?.trim() || undefined;
}

function defaultExtensionForContentType(contentType?: string): string {
  const clean = contentType?.split(";")[0]?.trim().toLowerCase();
  const extensions: Record<string, string> = {
    "application/json": ".json",
    "application/pdf": ".pdf",
    "application/xml": ".xml",
    "application/zip": ".zip",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
    "text/csv": ".csv",
    "text/html": ".html",
    "text/markdown": ".md",
    "text/plain": ".txt",
  };
  return clean ? extensions[clean] ?? "" : "";
}

function withContentTypeExtension(filename: string, contentType?: string): string {
  const ext = defaultExtensionForContentType(contentType);
  if (!ext) return filename;
  const currentExt = path.extname(filename);
  if (!currentExt) return `${filename}${ext}`;
  if (currentExt.toLowerCase() === ".bin") {
    return `${filename.slice(0, -currentExt.length)}${ext}`;
  }
  return filename;
}

function decodePathComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hasKnownFileExtension(value: string): boolean {
  const clean = value.split(/[?#]/, 1)[0] ?? value;
  return OUTPUT_FILE_EXTENSIONS.has(path.extname(clean).toLowerCase());
}

function trimAfterKnownFileExtension(value: string): string {
  let end = -1;
  const lower = value.toLowerCase();
  for (const ext of OUTPUT_FILE_EXTENSIONS) {
    const idx = lower.indexOf(ext);
    if (idx === -1) continue;
    const candidateEnd = idx + ext.length;
    if (candidateEnd > end) end = candidateEnd;
  }
  return end === -1 ? value : value.slice(0, end);
}

function normalizeFileReference(raw: string): string {
  let value = raw.trim();
  value = value.replace(/\s+["'][^"']*["']\s*$/, "");
  const angle = /^<([^>\n]+)>/.exec(value);
  if (angle) value = angle[1] ?? "";
  value = value.trim().replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "");
  value = trimAfterKnownFileExtension(value);
  return value.trim().replace(/[.,;:!?]+$/g, "");
}

function bytesFromBase64(value: string): Uint8Array {
  const match = value.match(/^data:([^;,]+)?;base64,(.*)$/s);
  return Buffer.from(match ? match[2] : value, "base64");
}

function fileContentDigest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

function fileKeyForPath(filePath: string, mtimeMs: number, size: number, data: Uint8Array): string {
  return `file:${path.resolve(filePath)}:${mtimeMs}:${size}:${fileContentDigest(data)}`;
}

function isInsideDir(filePath: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(filePath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function filenameFromRecord(record: Record<string, unknown>, fallback: string, contentType?: string): string {
  const direct = record.filename ?? record.name ?? record.title ?? record.path ?? record.filePath ?? record.uri;
  const filename = typeof direct === "string" && direct.trim() ? safeFilename(direct) : fallback;
  return withContentTypeExtension(filename, contentType);
}

function inlineFileFromRecord(record: Record<string, unknown>, fallbackName: string): ExtractedFile | null {
  const blob = typeof record.blob === "string"
    ? record.blob
    : typeof record.data_b64 === "string"
      ? record.data_b64
      : typeof record.data === "string"
        ? record.data
        : null;
  const explicitContentType = typeof record.mimeType === "string"
    ? record.mimeType
    : typeof record.contentType === "string"
      ? record.contentType
      : contentTypeFromDataUrl(blob);
  const filename = filenameFromRecord(record, fallbackName, explicitContentType);
  const contentType = guessContentType(filename, explicitContentType);
  const text = typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : null;
  if (text !== null) {
    return {
      key: `text:${filename}:${text.length}:${text.slice(0, 128)}`,
      filename,
      contentType: contentType ?? "text/plain",
      data: Buffer.from(text, "utf8"),
    };
  }
  if (blob !== null) {
    const data = bytesFromBase64(blob);
    return {
      key: `blob:${filename}:${data.byteLength}:${blob.slice(0, 128)}`,
      filename,
      contentType,
      data,
    };
  }
  return null;
}

async function fileFromUri(uri: string, cwd: string | undefined, resource: Record<string, unknown>): Promise<ExtractedFile | null> {
  if (!uri.startsWith("file://")) return null;
  try {
    return fileFromPath(stripTextLocationSuffix(fileURLToPath(uri)), cwd, resource);
  } catch {
    return null;
  }
}

function filePathFromReference(ref: string, cwd: string | undefined): string | null {
  const value = normalizeFileReference(ref);
  if (!value) return null;
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  if (path.isAbsolute(value)) {
    return decodePathComponent(value);
  }
  if (!cwd) return null;
  if (value.startsWith("./") || value.startsWith("../") || value.includes("/") || hasKnownFileExtension(value)) {
    return path.resolve(cwd, decodePathComponent(value));
  }
  return null;
}

async function fileFromReference(
  ref: string,
  cwd: string | undefined,
  resource: Record<string, unknown>,
  options: { minMtimeMs?: number } = {},
): Promise<ExtractedFile | null> {
  const filePath = filePathFromReference(ref, cwd);
  if (!filePath) return null;
  return fileFromPath(filePath, cwd, resource, options);
}

async function fileFromPath(
  filePath: string,
  cwd: string | undefined,
  resource: Record<string, unknown>,
  options: { minMtimeMs?: number } = {},
): Promise<ExtractedFile | null> {
  const root = cwd ? path.resolve(cwd) : process.cwd();
  if (!isInsideDir(filePath, root)) return null;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    if (options.minMtimeMs !== undefined && info.mtimeMs + 1000 < options.minMtimeMs) return null;
    const filename = filenameFromRecord(resource, safeFilename(filePath));
    const data = await readFile(filePath);
    return {
      key: fileKeyForPath(filePath, info.mtimeMs, info.size, data),
      filename,
      contentType: guessContentType(
        filename,
        typeof resource.mimeType === "string" ? resource.mimeType : undefined,
      ),
      data,
      path: path.resolve(filePath),
    };
  } catch {
    return null;
  }
}

function stripTextLocationSuffix(filePath: string): string {
  const match = /^(.+):(\d+)(?::\d+)?$/.exec(filePath);
  if (!match) return filePath;
  return path.isAbsolute(match[1]) ? match[1] : filePath;
}

function markdownTargetToReference(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("<")) {
    const end = value.indexOf(">");
    if (end > 0) return value.slice(1, end);
  }
  return value.replace(/\s+["'][^"']*["']\s*$/, "");
}

function localFileReferencesFromText(text: string, cwd: string | undefined): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const filePath = filePathFromReference(raw, cwd);
    if (!filePath) return;
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    refs.push(resolved);
  };

  const markdownLinkRe = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
  for (const match of text.matchAll(markdownLinkRe)) add(markdownTargetToReference(match[1] ?? ""));

  const angleRefRe = /<(file:\/\/[^>\n]+|\/[^>\n]+|\.\.?\/[^>\n]+)>/g;
  for (const match of text.matchAll(angleRefRe)) add(match[1] ?? "");

  const backtickRefRe = /`([^`\n]+)`/g;
  for (const match of text.matchAll(backtickRefRe)) add(match[1] ?? "");

  const quotedRefRe = /["'](file:\/\/[^"'\n]+|\/[^"'\n]+|\.\.?\/[^"'\n]+|[^"'\n]+\.[A-Za-z0-9]{1,8})["']/g;
  for (const match of text.matchAll(quotedRefRe)) add(match[1] ?? "");

  const labeledPathRe = /(?:created|saved|wrote|written|output|exported|file|path|report|生成|保存|写入|输出|文件|路径)[^:\n]{0,80}:\s*([^\n]+)/gi;
  for (const match of text.matchAll(labeledPathRe)) add(match[1] ?? "");

  const bareFileUriRe = /file:\/\/[^\s)\]>"']+/g;
  for (const match of text.matchAll(bareFileUriRe)) add(match[0] ?? "");

  const barePathRe = /(?:^|[\s(:])((?:\/|\.\.?\/)[^\s`"'<>),;]+?\.[A-Za-z0-9]{1,8})(?=$|[\s),.;:!?])/g;
  for (const match of text.matchAll(barePathRe)) add(match[1] ?? "");

  return refs;
}

async function extractFilesFromTextLinks(
  text: string,
  cwd: string | undefined,
  minMtimeMs: number,
): Promise<ExtractedFile[]> {
  const files: ExtractedFile[] = [];
  for (const filePath of localFileReferencesFromText(text, cwd)) {
    const file = await fileFromPath(filePath, cwd, {}, { minMtimeMs });
    if (file) files.push(file);
  }
  return files;
}

async function extractFilesFromContent(
  content: unknown,
  cwd: string | undefined,
  fallbackName = "acp-output.bin",
  options: { textMinMtimeMs?: number } = {},
): Promise<ExtractedFile[]> {
  if (Array.isArray(content)) {
    const nested = await Promise.all(content.map((item) => extractFilesFromContent(item, cwd, fallbackName, options)));
    return nested.flat();
  }
  if (!content || typeof content !== "object") return [];
  const block = content as Record<string, unknown>;
  const files: ExtractedFile[] = [];
  if (block.resource && typeof block.resource === "object") {
    const resource = block.resource as Record<string, unknown>;
    const inline = inlineFileFromRecord(resource, fallbackName);
    if (inline) files.push(inline);
    for (const field of FILE_REFERENCE_FIELDS) {
      const ref = resource[field];
      if (typeof ref !== "string" || !ref.trim()) continue;
      const fromRef = !inline ? await fileFromReference(ref, cwd, resource) : null;
      if (fromRef) files.push(fromRef);
    }
  }
  const inline = (
    block.type === "file"
    || block.type === "image"
    || block.type === "resource"
    || typeof block.blob === "string"
    || typeof block.data_b64 === "string"
    || (typeof block.data === "string" && (typeof block.mimeType === "string" || typeof block.contentType === "string"))
    || (typeof block.text === "string" && (typeof block.filename === "string" || typeof block.name === "string"))
  )
    ? inlineFileFromRecord(block, fallbackName)
    : null;
  if (inline) files.push(inline);
  for (const field of FILE_REFERENCE_FIELDS) {
    const ref = block[field];
    if (typeof ref !== "string" || !ref.trim()) continue;
    const fromRef = !inline ? await fileFromReference(ref, cwd, block) : null;
    if (fromRef) files.push(fromRef);
  }
  for (const field of TEXT_REFERENCE_FIELDS) {
    const text = block[field];
    if (typeof text !== "string" || !text.trim()) continue;
    files.push(...await extractFilesFromTextLinks(text, cwd, options.textMinMtimeMs ?? 0));
  }
  for (const field of NESTED_CONTENT_FIELDS) {
    const nested = block[field];
    if (!nested || typeof nested === "string") continue;
    files.push(...await extractFilesFromContent(nested, cwd, fallbackName, options));
  }
  return files;
}

function summarizeUpdate(update: Record<string, unknown>): string {
  const kind = String(update.sessionUpdate ?? "update");
  if (kind === "plan" && Array.isArray(update.entries)) {
    return update.entries
      .map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        const e = entry as Record<string, unknown>;
        return `${e.status ?? "pending"}: ${e.content ?? ""}`.trim();
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof update.title === "string") return update.title;
  if (typeof update.message === "string") return update.message;
  return kind;
}

function permissionOptions(params: unknown): PermissionOption[] {
  if (!isObject(params) || !Array.isArray(params.options)) return [];
  const options: PermissionOption[] = [];
  for (const option of params.options.filter(isObject)) {
    const optionId = cleanConfigText(option.optionId, cleanConfigText(option.id));
    if (!optionId) continue;
    options.push({
      option_id: optionId,
      kind: cleanConfigText(option.kind) || undefined,
      name: cleanConfigText(option.name, optionId),
      description: cleanConfigText(option.description, "") || undefined,
    });
  }
  return options;
}

function permissionOptionIdForResolution(params: unknown, resolution: "allow" | "deny"): string | null {
  const options = permissionOptions(params);
  const prefix = resolution === "allow" ? "allow" : "reject";
  return options.find((option) => String(option.kind ?? "").startsWith(prefix))?.option_id ?? null;
}

function permissionToolCall(params: unknown): Record<string, unknown> {
  return isObject(params) && isObject(params.toolCall) ? params.toolCall : {};
}

function permissionText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function permissionTitle(params: unknown): string {
  const toolCall = permissionToolCall(params);
  return (
    permissionText(toolCall.title)
    || permissionText(toolCall.name)
    || permissionText(toolCall.tool)
    || "ACP permission request"
  );
}

function permissionToolName(params: unknown): string | null {
  const toolCall = permissionToolCall(params);
  return (
    permissionText(toolCall.tool)
    || permissionText(toolCall.name)
    || permissionText(toolCall.toolName)
    || permissionText(toolCall.title)
    || null
  );
}

function permissionBody(params: unknown): string {
  const title = permissionTitle(params);
  const toolCall = permissionToolCall(params);
  const detail = (
    permissionText(toolCall.message)
    || permissionText(toolCall.description)
    || permissionText(toolCall.content)
  );
  if (detail && detail !== title) return `${title}\n\n${detail}`;
  return title;
}

function providerSessionKeyOf(message: InboundMessage): string | null {
  const event = message.event;
  const fromEvent = event.provider_session_key;
  const fromSession = event.session?.provider_session_key;
  if (typeof fromEvent === "string" && fromEvent) return fromEvent;
  if (typeof fromSession === "string" && fromSession) return fromSession;
  return null;
}

function readStringField(obj: unknown, key: string): string | undefined {
  if (!isObject(obj)) return undefined;
  const raw = obj[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function messageSessionContext(message: InboundMessage): {
  sessionId?: string;
  providerSessionKey: string;
  providerSessionId?: string;
} {
  const event = message.event;
  const sourceProviderSessionId = readStringField(event, "provider_session_id");
  const sourceSession = event.session;
  return {
    sessionId: readStringField(sourceSession, "id"),
    providerSessionKey: providerSessionKeyOf(message) ?? "",
    providerSessionId: sourceProviderSessionId ?? readStringField(sourceSession, "provider_session_id"),
  };
}

function withSessionFields(frame: {
  session_id?: string;
  provider_session_key?: string | null;
  provider_session_id?: string;
}, ctx: RunContext): {
  session_id?: string;
  provider_session_key: string;
  provider_session_id: string;
} {
  frame.session_id = frame.session_id ?? ctx.sourceSessionId;
  frame.provider_session_key = frame.provider_session_key ?? ctx.providerSessionKey;
  frame.provider_session_id = frame.provider_session_id ?? ctx.acpSessionId;
  return {
    session_id: frame.session_id,
    provider_session_key: frame.provider_session_key,
    provider_session_id: frame.provider_session_id,
  };
}

function deriveHttpBase(wsUrl: string): string {
  try {
    const url = new URL(wsUrl);
    const protocol = url.protocol === "wss:" ? "https:" : "http:";
    const prefix = url.pathname.replace(/\/ws\/agent-bridge\/(?:control|data)\/?$/, "").replace(/\/$/, "");
    return `${protocol}//${url.host}${prefix}`;
  } catch {
    return "";
  }
}

function isImageAttachment(attachment: AgentNexusAttachment): boolean {
  return (
    String(attachment.content_type || "").toLowerCase().startsWith("image/")
    || attachment.is_image === true
    || String(attachment.is_image || "").toLowerCase() === "true"
  );
}

function normalizedContentType(value: string | null | undefined): string {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function isTextHydrationCandidate(attachment: AttachmentInfo): boolean {
  const filename = attachment.filename || "";
  const ext = path.extname(filename).toLowerCase();
  if (ext) return TEXT_ATTACHMENT_EXTENSIONS.has(ext);
  return TEXT_ATTACHMENT_CONTENT_TYPES.has(normalizedContentType(attachment.content_type));
}

function safePathSegment(value: string | null | undefined, fallback: string): string {
  return safeFilename(value || fallback).slice(0, 160);
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "ask" || value === "reject" || value === "allow" || value === "cancel";
}

function pickTimeoutMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < REMOTE_TIMEOUT_MIN_MS || rounded > REMOTE_TIMEOUT_MAX_MS) return null;
  return rounded;
}

function isOpenCodeAcpCommand(command: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === "opencode" || base === "opencode.exe";
}

function parseOpenCodeConfigEnv(raw: string | undefined): Record<string, unknown> {
  let config: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      config = {};
    }
  }
  return config;
}

function withOpenCodeConfigEnv(
  env: Record<string, string> | undefined,
  patch: Record<string, unknown>,
): Record<string, string> {
  const next = { ...(env ?? {}) };
  const config = { ...parseOpenCodeConfigEnv(next.OPENCODE_CONFIG_CONTENT), ...patch };
  next.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  return next;
}

function openCodePermissionForNativeMode(mode: string): Record<string, "allow" | "ask" | "deny"> | null {
  if (mode === "allow") return { edit: "allow", bash: "allow" };
  if (mode === "ask") return { edit: "ask", bash: "ask" };
  if (mode === "deny" || mode === "reject") return { edit: "deny", bash: "deny" };
  return null;
}

function withOpenCodeModelEnv(env: Record<string, string> | undefined, model: string): Record<string, string> {
  return withOpenCodeConfigEnv(env, { model });
}

function withOpenCodePermissionEnv(
  env: Record<string, string> | undefined,
  mode: string,
): Record<string, string> {
  const permission = openCodePermissionForNativeMode(mode);
  if (!permission) return { ...(env ?? {}) };
  return withOpenCodeConfigEnv(env, { permission });
}

async function normalizeRemoteSettings(input: unknown, currentCwd: string | undefined): Promise<SettingsApplyResult> {
  const rejected: SettingsApplyResult["rejected"] = [];
  const settings: RemoteConnectorSettings = {};
  if (!input || typeof input !== "object") {
    return {
      applied: [],
      rejected: [{ field: "settings", reason: "settings must be an object" }],
      settings,
    };
  }
  const raw = input as Record<string, unknown>;
  if ("agentnexusApprovalMode" in raw) {
    if (isPermissionMode(raw.agentnexusApprovalMode)) {
      settings.agentnexusApprovalMode = raw.agentnexusApprovalMode;
    } else {
      rejected.push({ field: "agentnexusApprovalMode", reason: "must be ask, reject, allow, or cancel" });
    }
  }
  if ("agentNativePermissionMode" in raw) {
    if (typeof raw.agentNativePermissionMode === "string" && raw.agentNativePermissionMode.trim()) {
      settings.agentNativePermissionMode = raw.agentNativePermissionMode.trim();
    } else {
      rejected.push({ field: "agentNativePermissionMode", reason: "must be a non-empty string" });
    }
  }
  if ("permissionMode" in raw) {
    if (isPermissionMode(raw.permissionMode)) {
      settings.permissionMode = raw.permissionMode;
    } else {
      rejected.push({ field: "permissionMode", reason: "must be ask, reject, allow, or cancel" });
    }
  }
  for (const field of ["requestTimeoutMs", "promptTimeoutMs"] as const) {
    if (!(field in raw)) continue;
    const timeoutMs = pickTimeoutMs(raw[field]);
    if (timeoutMs === null) {
      rejected.push({
        field,
        reason: `must be between ${REMOTE_TIMEOUT_MIN_MS} and ${REMOTE_TIMEOUT_MAX_MS} ms`,
      });
    } else {
      settings[field] = timeoutMs;
    }
  }
  if ("cwd" in raw) {
    if (typeof raw.cwd !== "string" || !raw.cwd.trim()) {
      rejected.push({ field: "cwd", reason: "must be a non-empty string" });
    } else {
      const base = currentCwd ?? process.cwd();
      const resolved = path.isAbsolute(raw.cwd.trim())
        ? path.resolve(raw.cwd.trim())
        : path.resolve(base, raw.cwd.trim());
      try {
        const info = await stat(resolved);
        if (!info.isDirectory()) {
          rejected.push({ field: "cwd", reason: `not a directory: ${resolved}` });
        } else {
          settings.cwd = resolved;
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        rejected.push({ field: "cwd", reason: `cannot access directory: ${detail}` });
      }
    }
  }
  if ("model" in raw) {
    if (typeof raw.model !== "string" || !raw.model.trim()) {
      rejected.push({ field: "model", reason: "must be a non-empty string" });
    } else {
      const model = raw.model.trim();
      if (model.length > REMOTE_MODEL_MAX_LENGTH || /[\r\n\t]/.test(model)) {
        rejected.push({ field: "model", reason: `must be a single-line string up to ${REMOTE_MODEL_MAX_LENGTH} characters` });
      } else {
        settings.model = model;
      }
    }
  }
  if ("configOptions" in raw) {
    if (!isObject(raw.configOptions)) {
      rejected.push({ field: "configOptions", reason: "must be an object of config option values" });
    } else {
      const configOptions: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw.configOptions)) {
        const configId = key.trim();
        if (!configId) {
          rejected.push({ field: "configOptions", reason: "option ids must be non-empty strings" });
          continue;
        }
        if (typeof value !== "string" || !value.trim()) {
          rejected.push({ field: `configOptions.${configId}`, reason: "must be a non-empty string" });
          continue;
        }
        configOptions[configId] = value.trim();
      }
      settings.configOptions = configOptions;
    }
  }
  return { applied: [], rejected, settings };
}

function stripProviderErrorPrefix(message: string): string {
  return message
    .replace(/^JsonRpcError:\s*/i, "")
    .replace(/^Internal error:\s*/i, "")
    .trim();
}

function providerErrorKind(err: unknown): string {
  if (err instanceof JsonRpcError && err.data && typeof err.data === "object") {
    const data = err.data as Record<string, unknown>;
    if (typeof data.errorKind === "string") return data.errorKind;
    if (typeof data.error_kind === "string") return data.error_kind;
  }
  return "";
}

function errorSearchText(err: unknown): string {
  const parts = [err instanceof Error ? err.message : String(err)];
  if (err instanceof JsonRpcError && err.data !== undefined) {
    try {
      parts.push(JSON.stringify(err.data));
    } catch {
      parts.push(String(err.data));
    }
  }
  return parts.join(" ").toLowerCase();
}

function isNonPersistedOpenAIItemError(err: unknown): boolean {
  const text = errorSearchText(err);
  return (
    text.includes("items are not persisted")
    || (
      text.includes("item with id")
      && text.includes("not found")
      && text.includes("store")
      && text.includes("false")
    )
  );
}

function formatProviderError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const detail = stripProviderErrorPrefix(raw) || "Unknown provider error";
  const kind = providerErrorKind(err);
  const haystack = `${kind} ${detail}`.toLowerCase();

  if (
    kind === "authentication_failed"
    || haystack.includes("invalid authentication credentials")
    || haystack.includes("401")
    || haystack.includes("authrequired")
  ) {
    return [
      `Claude authentication failed: ${detail}`,
      "",
      "Run `claude-agent-acp --cli auth login --console` on the connector host, or configure `ANTHROPIC_API_KEY` in the connector `agent.env`, then restart the connector.",
    ].join("\n");
  }

  if (
    kind === "rate_limit"
    || haystack.includes("rate limit")
    || haystack.includes("hit your limit")
    || haystack.includes("quota")
  ) {
    return [
      `Claude usage limit reached: ${detail}`,
      "",
      "Wait until the reset time, or switch this connector to Anthropic Console/API billing and restart it.",
    ].join("\n");
  }

  if (
    kind === "billing_error"
    || haystack.includes("billing")
    || haystack.includes("credit balance")
    || haystack.includes("payment")
  ) {
    return [
      `Claude billing issue: ${detail}`,
      "",
      "Check the Anthropic Console billing status or switch to a working Claude account/API key, then retry.",
    ].join("\n");
  }

  if (
    kind.includes("permission")
    || haystack.includes("permission")
    || haystack.includes("not allowed")
    || haystack.includes("forbidden")
    || haystack.includes("does not support using claude.ai subscriptions")
  ) {
    return [
      `Claude permission issue: ${detail}`,
      "",
      "Approve the requested action, adjust the AgentNexus approval/native permission settings, or switch to a supported Claude Console/API login and retry.",
    ].join("\n");
  }

  return `ACP provider error: ${detail}`;
}

function attachmentUri(attachment: AgentNexusAttachment): string {
  const id = attachment.file_id || "unknown";
  const name = attachment.filename ? `/${encodeURIComponent(attachment.filename)}` : "";
  return `agentnexus://file/${encodeURIComponent(id)}${name}`;
}

async function fetchBridgeJson(
  url: string,
  botToken: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown> | null> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 240);
    } catch {
      detail = "";
    }
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const body = await response.json() as { data?: unknown };
  return body.data && typeof body.data === "object" ? body.data as Record<string, unknown> : null;
}

async function fetchBridgeTextFile(
  httpBase: string,
  botToken: string,
  attachment: AgentNexusAttachment,
): Promise<BridgeTextFile | null> {
  if (!httpBase || !attachment.file_id) return null;
  const url = `${httpBase}/api/v1/agent-bridge/files/${encodeURIComponent(attachment.file_id)}/content`;
  const data = await fetchBridgeJson(url, botToken);
  if (!data || typeof data.content !== "string") return null;
  return {
    filename: typeof data.filename === "string" ? data.filename : attachment.filename || attachment.file_id,
    contentType: typeof data.content_type === "string" ? data.content_type : attachment.content_type || "text/markdown",
    sizeBytes: typeof data.size_bytes === "number" ? data.size_bytes : attachment.size_bytes ?? undefined,
    summary: typeof data.summary === "string" ? data.summary : attachment.summary ?? undefined,
    content: data.content,
    truncated: data.truncated === true,
  };
}

async function fetchBridgeBinaryFile(
  httpBase: string,
  botToken: string,
  attachment: AgentNexusAttachment,
): Promise<BridgeBinaryFile | null> {
  if (!httpBase || !attachment.file_id) return null;
  const url = `${httpBase}/api/v1/agent-bridge/files/${encodeURIComponent(attachment.file_id)}/binary`;
  const data = await fetchBridgeJson(url, botToken);
  if (!data || typeof data.data_b64 !== "string") return null;
  return {
    filename: typeof data.filename === "string" ? data.filename : attachment.filename || attachment.file_id,
    contentType: typeof data.content_type === "string" ? data.content_type : attachment.content_type || "application/octet-stream",
    sizeBytes: typeof data.size_bytes === "number" ? data.size_bytes : attachment.size_bytes ?? undefined,
    dataB64: data.data_b64,
  };
}

function inlineImageFromAttachment(attachment: AgentNexusAttachment): BridgeBinaryFile | null {
  const raw = typeof attachment.image_b64 === "string" ? attachment.image_b64.trim() : "";
  if (!raw) return null;
  const dataUrlMatch = /^data:([^;,]+)?;base64,(.*)$/s.exec(raw);
  const dataB64 = dataUrlMatch ? dataUrlMatch[2] : raw;
  if (!dataB64) return null;
  return {
    filename: attachment.filename || attachment.file_id || "image",
    contentType: dataUrlMatch?.[1] || attachment.content_type || "application/octet-stream",
    sizeBytes: attachment.size_bytes ?? undefined,
    dataB64,
  };
}

async function saveBridgeBinaryAttachment(
  attachment: AgentNexusAttachment,
  options: PromptBuildOptions,
): Promise<LocalAttachmentFile | null> {
  const binary = await fetchBridgeBinaryFile(options.httpBase, options.botToken, attachment);
  if (!binary?.dataB64) return null;

  const fileId = attachment.file_id || "unknown";
  const taskSegment = safePathSegment(options.taskId, "task");
  const fileSegment = safePathSegment(fileId, "file");
  const filename = safeFilename(binary.filename || attachment.filename || fileId);
  const dir = path.join(options.cwd, ".agentnexus", "attachments", taskSegment, fileSegment);
  const target = path.join(dir, filename);
  await mkdir(dir, { recursive: true });
  const data = Buffer.from(binary.dataB64, "base64");
  await writeFile(target, data);
  const info = await stat(target);
  options.ignoreOutputFileKey?.(fileKeyForPath(target, info.mtimeMs, info.size, data));
  return {
    filename,
    contentType: binary.contentType || attachment.content_type || "application/octet-stream",
    sizeBytes: binary.sizeBytes ?? data.byteLength,
    path: target,
    uri: pathToFileURL(target).href,
  };
}

async function uploadBridgeBinaryFileHttp(
  httpBase: string,
  botToken: string,
  channelId: string,
  file: ExtractedFile,
  timeoutMs: number,
): Promise<BridgeUploadedFile | null> {
  if (!httpBase) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const response = await fetch(`${httpBase}/api/v1/agent-bridge/files/upload-binary`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": file.contentType ?? "application/octet-stream",
        "X-Channel-Id": channelId,
        "X-Filename": file.filename,
      },
      body: Buffer.from(file.data),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload: unknown = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = raw;
      }
    }
    if (!response.ok) {
      const detail = isObject(payload)
        ? String(payload.detail ?? payload.error ?? raw)
        : raw;
      throw new BridgeHttpUploadError(
        response.status,
        `HTTP ${response.status}: ${detail || response.statusText}`,
      );
    }
    const data = isObject(payload) && isObject(payload.data)
      ? payload.data
      : payload;
    if (!isObject(data) || typeof data.file_id !== "string") {
      throw new Error("upload response missing file_id");
    }
    return {
      file_id: data.file_id,
      filename: typeof data.filename === "string" ? data.filename : file.filename,
      content_type: typeof data.content_type === "string" ? data.content_type : file.contentType,
      size_bytes: typeof data.size_bytes === "number" ? data.size_bytes : file.data.byteLength,
      preview_url: typeof data.preview_url === "string" ? data.preview_url : undefined,
      download_url: typeof data.download_url === "string" ? data.download_url : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

function attachmentSummaryLine(attachment: AttachmentInfo): string {
  const name = attachment.filename || attachment.file_id || "attachment";
  const details = [attachment.content_type, attachment.size_bytes ? `${attachment.size_bytes} bytes` : null]
    .filter(Boolean)
    .join(", ");
  return `- ${name}${details ? ` (${details})` : ""}${attachment.summary ? `: ${attachment.summary}` : ""}`;
}

async function attachmentToPromptBlocks(
  attachment: AgentNexusAttachment,
  options: PromptBuildOptions,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  if (!attachment.file_id) return blocks;

  if (isImageAttachment(attachment)) {
    if (options.supportsImages) {
      const inlineImage = inlineImageFromAttachment(attachment);
      if (inlineImage?.dataB64) {
        blocks.push({
          type: "image",
          mimeType: inlineImage.contentType,
          data: inlineImage.dataB64,
          uri: attachmentUri(attachment),
        });
        return blocks;
      }
      try {
        const image = await fetchBridgeBinaryFile(options.httpBase, options.botToken, attachment);
        if (image?.dataB64) {
          blocks.push({
            type: "image",
            mimeType: image.contentType,
            data: image.dataB64,
            uri: attachmentUri(attachment),
          });
          return blocks;
        }
        options.logger.warn("acp attachment image hydration returned no data file_id=%s", attachment.file_id);
      } catch (err) {
        options.logger.warn("acp attachment image hydration failed file_id=%s: %s", attachment.file_id, String(err));
      }
    }
    if (attachment.summary) {
      blocks.push({ type: "text", text: `[Image attachment unavailable: ${attachment.filename || attachment.file_id}]\n${attachment.summary}` });
    }
    return blocks;
  }

  if (isTextHydrationCandidate(attachment)) {
    try {
      const textFile = await fetchBridgeTextFile(options.httpBase, options.botToken, attachment);
      if (textFile?.content) {
        const text = textFile.truncated
          ? `${textFile.content}\n\n[AgentNexus note: file content was truncated before sending to ACP.]`
          : textFile.content;
        if (options.supportsEmbeddedContext) {
          blocks.push({
            type: "resource",
            resource: {
              uri: attachmentUri(attachment),
              mimeType: "text/markdown",
              text,
            },
          });
        } else {
          blocks.push({ type: "text", text: `--- Attachment: ${textFile.filename} ---\n${text}\n--- End attachment ---` });
        }
        return blocks;
      }
    } catch (err) {
      options.logger.warn("acp attachment resource hydration failed file_id=%s: %s", attachment.file_id, String(err));
    }
  }

  try {
    const localFile = await saveBridgeBinaryAttachment(attachment, options);
    if (localFile) {
      blocks.push({
        type: "resource_link",
        uri: localFile.uri,
        name: localFile.filename,
        mimeType: localFile.contentType,
        ...(localFile.sizeBytes ? { size: localFile.sizeBytes } : {}),
      });
      blocks.push({
        type: "text",
        text: [
          `--- Attachment file: ${localFile.filename} ---`,
          `Saved locally: ${localFile.path}`,
          `File URI: ${localFile.uri}`,
          `MIME type: ${localFile.contentType}`,
          localFile.sizeBytes ? `Size: ${localFile.sizeBytes} bytes` : null,
          "Use local file tools to inspect this attachment if its content is needed.",
          "--- End attachment file ---",
        ].filter(Boolean).join("\n"),
      });
      return blocks;
    }
  } catch (err) {
    options.logger.warn("acp attachment binary hydration failed file_id=%s: %s", attachment.file_id, String(err));
  }

  if (attachment.summary) {
    blocks.push({
      type: "text",
      text: `--- Attachment summary: ${attachment.filename || attachment.file_id} ---\n${attachment.summary}\n--- End attachment summary ---`,
    });
  }
  return blocks;
}

async function buildPrompt(message: InboundMessage, options: PromptBuildOptions): Promise<ContentBlock[]> {
  const parts: string[] = [AGENTNEXUS_ACP_OUTPUT_CONTRACT];
  if (message.text.trim()) parts.push(message.text.trim());
  if (message.attachments.length > 0) {
    parts.push(
      [
        "AgentNexus attachments:",
        ...message.attachments.map(attachmentSummaryLine),
      ].join("\n"),
    );
  }
  const blocks: ContentBlock[] = [{ type: "text", text: parts.join("\n\n") || message.text || " " }];
  for (const attachment of message.attachments) {
    blocks.push(...await attachmentToPromptBlocks(attachment, options));
  }
  return blocks;
}

export class AcpBridgeAccount {
  private readonly bridge: BotSession;
  private readonly agent: AcpStdioAgent;
  private readonly activeProviderSessions = new Map<string, string>();
  private readonly providerSessionKeysByAcpSession = new Map<string, string>();
  private readonly activeRunsBySession = new Map<string, RunContext>();
  private readonly activeRunsByMsg = new Map<string, RunContext>();
  private readonly queuesByProviderSessionKey = new Map<string, Promise<void>>();
  private readonly configOptionsBySession = new Map<string, AcpConfigOption[]>();
  private readonly pendingPermissions = new Map<string, PendingPermissionRequest>();
  private readonly reportedProviderSessions = new Set<string>();
  private desiredAcpConfigOptions: Record<string, string> = {};
  private desiredAcpConfigOptionsKey = acpConfigOptionsKey({});
  private discoveredOptions: AcpDiscoveredOptions | null = null;
  private readonly acpCapabilitySigner = this.config.acpCapability
    ? buildAcpCapabilitySigner(this.config.acpCapability)
    : null;

  constructor(
    private readonly accountId: string,
    private readonly config: AccountConfig,
    private readonly state: SessionStateStore,
    private readonly logger: Logger,
  ) {
    this.agent = new AcpStdioAgent(
      accountId,
      config.agent,
      logger,
      (params) => this.handleAcpPermissionRequest(params),
    );
    this.agent.onSessionUpdate((update) => this.handleAcpUpdate(update));
    this.bridge = new BotSession(
      {
        botToken: config.botToken,
        controlUrl: config.controlUrl,
        dataUrl: config.dataUrl,
        advanced: config.advanced,
      },
      {
        onReady: () => this.logger.info("bridge account=%s ready", this.accountId),
        onMessage: (message) => this.enqueueMessage(message),
        onCancel: (msgId, reason) => this.handleCancel(msgId, reason),
        onConfigUpdate: (update) => this.handleConfigUpdate(update),
        onConfigOptionSet: (update) => this.handleConfigOptionSet(update),
        onPermissionResolution: (resolution) => this.handlePermissionResolution(resolution),
        onFatal: (reason) => this.logger.error("bridge account=%s fatal: %s", this.accountId, reason),
        onError: (err) => this.logger.error("bridge account=%s error: %s", this.accountId, String(err)),
        onDataFramePrepare: (frame, security) => this.onAcpDataFramePrepare(frame, security),
        onConnectionChange: (stream, state) => this.logger.info(
          "bridge account=%s %s=%s",
          this.accountId,
          stream,
          state,
        ),
      },
    );
  }

  async start(): Promise<void> {
    await this.agent.start();
    this.bridge.start();
    await this.bridge.waitReady(15_000);
    this.reportAcpDiscoveredOptions(null, null, {});
  }

  async stop(): Promise<void> {
    for (const [requestId, pending] of this.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve({ outcome: "cancelled" });
      this.pendingPermissions.delete(requestId);
    }
    await Promise.allSettled([this.bridge.stop(), this.agent.stop()]);
  }

  private onAcpDataFramePrepare(frame: OutboundAcpDataFrame, security: AcpSecurityHello | null): void {
    if (!security?.require_capability) return;
    if (security.algorithm && security.algorithm.toLowerCase() !== ACP_CAPABILITY_SUPPORTED_ALGORITHM) {
      throw new Error(
        `unsupported acp capability algorithm in hello: ${security.algorithm}, expected ${ACP_CAPABILITY_SUPPORTED_ALGORITHM}`,
      );
    }
    if (!this.acpCapabilitySigner) {
      throw new Error(`acp_capability missing for account=${this.accountId}, but require_capability is true`);
    }
    if (!frameNeedsAcpCapability(frame.type)) return;
    const envelope = this.acpCapabilitySigner.sign(frame);
    frame.acp_capability = envelope;
  }

  private reportAcpDiscoveredOptions(
    providerSessionKey: string | null,
    sessionId: string | null,
    payload: Record<string, unknown>,
  ): void {
    const next: AcpDiscoveredOptions = {
      ...(this.discoveredOptions ?? { source: "acp" as const, updatedAt: "" }),
      source: "acp",
      agentInfo: this.agent.initializeResponse?.agentInfo ?? this.discoveredOptions?.agentInfo,
      agentCapabilities: this.agent.initializeResponse?.agentCapabilities ?? this.discoveredOptions?.agentCapabilities,
      updatedAt: new Date().toISOString(),
    };
    if (providerSessionKey) next.providerSessionKey = providerSessionKey;
    if (sessionId) next.sessionId = sessionId;
    if (hasOwn(payload, "modes")) next.modes = payload.modes;
    if (hasOwn(payload, "configOptions")) next.configOptions = normalizeAcpConfigOptions(payload.configOptions);
    if (hasOwn(payload, "availableCommands")) next.availableCommands = payload.availableCommands;

    const kind = typeof payload.sessionUpdate === "string" ? payload.sessionUpdate : "";
    if (kind === "current_mode_update" && typeof payload.currentModeId === "string") {
      next.modes = {
        ...(isObject(next.modes) ? next.modes : {}),
        currentModeId: payload.currentModeId,
      };
    }
    if (kind === "config_option_update" && hasOwn(payload, "configOptions")) {
      next.configOptions = normalizeAcpConfigOptions(payload.configOptions);
    }
    if (kind === "available_commands_update" && hasOwn(payload, "availableCommands")) {
      next.availableCommands = payload.availableCommands;
    }

    this.discoveredOptions = next;
    if (!this.bridge.sendConfigOptions({ options: normalizeDiscoveredOptions(next) })) {
      this.logger.debug?.("bridge account=%s skipped config_options; control stream is not open", this.accountId);
    }
  }

  private reportProviderSessionIdentity(providerSessionKey: string, providerSessionId: string): void {
    if (this.reportedProviderSessions.has(providerSessionId)) return;
    this.reportedProviderSessions.add(providerSessionId);
    if (!this.bridge.reportProviderSession({
      provider_session_key: providerSessionKey,
      provider_session_id: providerSessionId,
      metadata: {
        account_id: this.accountId,
        command: this.config.agent.command,
        cwd: this.config.agent.cwd ?? null,
      },
    })) {
      this.logger.debug?.(
        "bridge account=%s skipped session_update; data stream is not open for session=%s",
        this.accountId,
        providerSessionId,
      );
    }
  }

  private updateSessionConfigOptions(sessionId: string, configOptions: unknown): AcpConfigOption[] | undefined {
    if (configOptions === undefined) return undefined;
    const normalized = normalizeAcpConfigOptions(configOptions);
    if (normalized.length > 0) {
      this.configOptionsBySession.set(sessionId, normalized);
    } else {
      this.configOptionsBySession.delete(sessionId);
    }
    return normalized;
  }

  private async applyDesiredConfigOptionsToActiveSessions(): Promise<Array<{ field: string; reason: string }>> {
    const rejected: Array<{ field: string; reason: string }> = [];
    const seen = new Set<string>();
    for (const sessionId of this.activeProviderSessions.values()) {
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      rejected.push(...await this.applyDesiredSessionConfigOptions(sessionId));
    }
    return rejected;
  }

  private async applyDesiredSessionConfigOptions(
    sessionId: string,
    options: AcpConfigOption[] | undefined = this.configOptionsBySession.get(sessionId),
  ): Promise<Array<{ field: string; reason: string }>> {
    const rejected: Array<{ field: string; reason: string }> = [];
    const entries = Object.entries(this.desiredAcpConfigOptions);
    if (entries.length === 0 || !options || options.length === 0) return rejected;

    let currentOptions = options;
    for (const [configId, value] of entries) {
      const option = currentOptions.find((item) => item.id === configId);
      if (!option) continue;
      if (option.currentValue === value) continue;
      if (option.options.length > 0 && !option.options.some((item) => item.value === value)) {
        rejected.push({
          field: `configOptions.${configId}`,
          reason: `unsupported value: ${value}`,
        });
        continue;
      }
      try {
        const nextOptions = await this.agent.setConfigOption(sessionId, configId, value);
        const normalized = this.updateSessionConfigOptions(sessionId, nextOptions);
        if (normalized) {
          currentOptions = normalized;
          this.reportAcpDiscoveredOptions(
            this.providerSessionKeysByAcpSession.get(sessionId) ?? null,
            sessionId,
            { configOptions: normalized },
          );
        }
      } catch (err) {
        rejected.push({
          field: `configOptions.${configId}`,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return rejected;
  }

  private enqueueMessage(message: InboundMessage): void {
    const providerSessionKey = providerSessionKeyOf(message);
    if (!providerSessionKey) {
      this.logger.warn("acp account=%s missing provider_session_key; dropping message for strong isolation", this.accountId);
      return;
    }
    const previous = this.queuesByProviderSessionKey.get(providerSessionKey) ?? Promise.resolve();
    let next: Promise<void>;
    next = previous
      .catch(() => undefined)
      .then(() => this.handleMessage(message))
      .catch((err) => {
        this.logger.error(
          "account=%s session=%s message failed: %s",
          this.accountId,
          providerSessionKey,
          String(err),
        );
      })
      .finally(() => {
        if (this.queuesByProviderSessionKey.get(providerSessionKey) === next) {
          this.queuesByProviderSessionKey.delete(providerSessionKey);
        }
      });
    this.queuesByProviderSessionKey.set(providerSessionKey, next);
  }

  private async ensureAcpSession(providerSessionKey: string): Promise<string> {
    const active = this.activeProviderSessions.get(providerSessionKey);
    if (active) return active;
    const saved = this.state.get(this.accountId, providerSessionKey);
    if (saved && this.agent.supportsLoadSession()) {
      try {
        const loaded = await this.agent.loadSession(saved);
        this.activeProviderSessions.set(providerSessionKey, saved);
        this.providerSessionKeysByAcpSession.set(saved, providerSessionKey);
        this.reportProviderSessionIdentity(providerSessionKey, saved);
        const options = this.updateSessionConfigOptions(saved, loaded.configOptions);
        this.reportAcpDiscoveredOptions(providerSessionKey, saved, loaded);
        const rejected = await this.applyDesiredSessionConfigOptions(saved, options);
        for (const item of rejected) {
          this.logger.warn("acp account=%s rejected saved ACP session config %s: %s", this.accountId, item.field, item.reason);
        }
        this.logger.info("acp account=%s loaded session %s", this.accountId, saved);
        return saved;
      } catch (err) {
        this.logger.warn(
          "acp account=%s failed to load session %s: %s",
          this.accountId,
          saved,
          String(err),
        );
      }
    }
    return this.createAcpSession(providerSessionKey);
  }

  private async createAcpSession(providerSessionKey: string): Promise<string> {
    const created = await this.agent.newSession();
    this.activeProviderSessions.set(providerSessionKey, created.sessionId);
    this.providerSessionKeysByAcpSession.set(created.sessionId, providerSessionKey);
    await this.state.set(this.accountId, providerSessionKey, created.sessionId);
    this.reportProviderSessionIdentity(providerSessionKey, created.sessionId);
    const options = this.updateSessionConfigOptions(created.sessionId, created.configOptions);
    this.reportAcpDiscoveredOptions(providerSessionKey, created.sessionId, created);
    const rejected = await this.applyDesiredSessionConfigOptions(created.sessionId, options);
    for (const item of rejected) {
      this.logger.warn("acp account=%s rejected new ACP session config %s: %s", this.accountId, item.field, item.reason);
    }
    this.logger.info("acp account=%s created session %s for %s", this.accountId, created.sessionId, providerSessionKey);
    return created.sessionId;
  }

  private async forgetAcpSession(providerSessionKey: string, acpSessionId: string): Promise<void> {
    if (this.activeProviderSessions.get(providerSessionKey) === acpSessionId) {
      this.activeProviderSessions.delete(providerSessionKey);
    }
    this.providerSessionKeysByAcpSession.delete(acpSessionId);
    this.reportedProviderSessions.delete(acpSessionId);
    this.configOptionsBySession.delete(acpSessionId);
    await this.state.remove(this.accountId, providerSessionKey);
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    const providerSessionKey = providerSessionKeyOf(message);
    if (!providerSessionKey) {
      this.logger.warn("acp account=%s missing provider_session_key; aborting message handling", this.accountId);
      return;
    }
    const sourceSession = messageSessionContext(message);
    const acpSessionId = await this.ensureAcpSession(providerSessionKey);
    const msgId = message.event.placeholder_msg_id || `${message.event.task_id}`;
    const ctx: RunContext = {
      source: message,
      providerSessionKey,
      sourceSessionId: sourceSession.sessionId,
      acpSessionId,
      msgId,
      httpBase: deriveHttpBase(this.config.dataUrl),
      botToken: this.config.botToken,
      startedAtMs: Date.now(),
      deltaSeq: 0,
      traceSeq: 0,
      text: "",
      sentDelta: false,
      fileIds: [],
      seenFileKeys: new Set<string>(),
      ignoredOutputFileKeys: new Set<string>(),
      pendingFileUploads: [],
    };
    this.activeRunsBySession.set(acpSessionId, ctx);
    this.activeRunsByMsg.set(msgId, ctx);
    this.tracePromptStarted(ctx);
    try {
      await this.runAcpPromptToCompletion(ctx);
    } catch (err) {
      let failure: unknown = err;
      if (isNonPersistedOpenAIItemError(failure) && !ctx.sentDelta && ctx.fileIds.length === 0) {
        try {
          await this.retryAfterNonPersistedOpenAIItem(ctx);
          return;
        } catch (retryErr) {
          failure = retryErr;
        }
      }
      if (isNonPersistedOpenAIItemError(failure)) {
        await this.forgetAcpSession(providerSessionKey, ctx.acpSessionId);
      }
      const detail = failure instanceof Error ? failure.message : String(failure);
      let userMessage = formatProviderError(failure);
      if (failure instanceof JsonRpcRequestTimeoutError && failure.method === "session/prompt") {
        this.agent.cancel(ctx.acpSessionId);
        userMessage = detail;
        this.bridge.trace({
          msg_id: msgId,
          ...withSessionFields({}, ctx),
          task_id: message.event.task_id,
          channel_id: message.channelId,
          run_id: ctx.acpSessionId,
          stream: "acp",
          seq: ++ctx.traceSeq,
          phase: "prompt_timeout",
          status: "failed",
          title: "ACP prompt timed out",
          message: detail,
          data: { timeoutMs: failure.timeoutMs },
        });
      } else {
        this.bridge.trace({
          msg_id: msgId,
          ...withSessionFields({}, ctx),
          task_id: message.event.task_id,
          channel_id: message.channelId,
          run_id: ctx.acpSessionId,
          stream: "acp",
          seq: ++ctx.traceSeq,
          phase: "prompt_failed",
          status: "error",
          title: "ACP prompt failed",
          message: userMessage,
          data: {
            error: detail,
            error_kind: providerErrorKind(failure) || undefined,
          },
        });
      }
      if (message.event.placeholder_msg_id) {
        const prefix = ctx.sentDelta && ctx.text.trim() ? "\n\n" : "";
        const visibleError = `${prefix}${userMessage}`;
        ctx.text += visibleError;
        ctx.sentDelta = true;
        this.bridge.streamDelta({
          msgId,
          seq: ++ctx.deltaSeq,
          delta: visibleError,
          sessionId: ctx.sourceSessionId,
          providerSessionId: ctx.acpSessionId,
          providerSessionKey: ctx.providerSessionKey,
        });
        const ack = await this.bridge.streamError({
          msgId,
          message: userMessage,
          sessionId: ctx.sourceSessionId,
          providerSessionId: ctx.acpSessionId,
          providerSessionKey: ctx.providerSessionKey,
        });
        if (!ack.ok) {
          this.logger.warn(
            "acp account=%s stream error not acknowledged msg_id=%s code=%s error=%s",
            this.accountId,
            msgId,
            ack.code,
            ack.error,
          );
        }
      } else {
        await this.bridge.reply({ source: message, text: userMessage });
      }
      throw failure;
    } finally {
      this.activeRunsBySession.delete(ctx.acpSessionId);
      this.activeRunsByMsg.delete(msgId);
    }
  }

  private tracePromptStarted(ctx: RunContext): void {
    this.bridge.trace({
      msg_id: ctx.msgId,
      ...withSessionFields({}, ctx),
      task_id: ctx.source.event.task_id,
      channel_id: ctx.source.channelId,
      run_id: ctx.acpSessionId,
      stream: "acp",
      seq: ++ctx.traceSeq,
      phase: "prompt_started",
      status: "running",
      title: "ACP prompt started",
      message: this.config.agent.command,
    });
  }

  private async runAcpPromptToCompletion(ctx: RunContext): Promise<void> {
    const capabilities = this.agent.initializeResponse?.agentCapabilities?.promptCapabilities ?? {};
    const result = await this.agent.prompt(ctx.acpSessionId, await buildPrompt(ctx.source, {
      httpBase: ctx.httpBase,
      botToken: ctx.botToken,
      cwd: this.config.agent.cwd ?? process.cwd(),
      taskId: ctx.source.event.task_id,
      supportsImages: capabilities.image === true,
      supportsEmbeddedContext: capabilities.embeddedContext === true,
      logger: this.logger,
      ignoreOutputFileKey: (fileKey) => ctx.ignoredOutputFileKeys.add(fileKey),
    }));
    await this.uploadTextLinkedFiles(ctx);
    await Promise.allSettled(ctx.pendingFileUploads);
    this.bridge.trace({
      msg_id: ctx.msgId,
      ...withSessionFields({}, ctx),
      task_id: ctx.source.event.task_id,
      channel_id: ctx.source.channelId,
      run_id: ctx.acpSessionId,
      stream: "acp",
      seq: ++ctx.traceSeq,
      phase: "prompt_finished",
      status: result.stopReason === "cancelled" ? "cancelled" : "completed",
      title: "ACP prompt finished",
      message: result.stopReason ?? "end_turn",
    });
    if (ctx.source.event.placeholder_msg_id) {
      const ack = await this.bridge.streamDone({
        msgId: ctx.msgId,
        fileIds: ctx.fileIds,
        content: ctx.text,
        sessionId: ctx.sourceSessionId,
        providerSessionId: ctx.acpSessionId,
        providerSessionKey: ctx.providerSessionKey,
      });
      if (!ack.ok) {
        this.logger.warn(
          "acp account=%s stream done not acknowledged msg_id=%s code=%s error=%s",
          this.accountId,
          ctx.msgId,
          ack.code,
          ack.error,
        );
      }
    } else {
      await this.bridge.reply({
        source: ctx.source,
        text: ctx.text || `[ACP completed: ${result.stopReason ?? "end_turn"}]`,
        fileIds: ctx.fileIds,
      });
    }
  }

  private async retryAfterNonPersistedOpenAIItem(ctx: RunContext): Promise<void> {
    const previousSessionId = ctx.acpSessionId;
    this.logger.warn(
      "acp account=%s rotating session=%s after non-persisted OpenAI Responses item error",
      this.accountId,
      previousSessionId,
    );
    await this.forgetAcpSession(ctx.providerSessionKey, previousSessionId);
    this.activeRunsBySession.delete(previousSessionId);
    const nextSessionId = await this.createAcpSession(ctx.providerSessionKey);
    ctx.acpSessionId = nextSessionId;
    ctx.startedAtMs = Date.now();
    ctx.text = "";
    ctx.sentDelta = false;
    ctx.fileIds = [];
    ctx.seenFileKeys.clear();
    ctx.ignoredOutputFileKeys.clear();
    ctx.pendingFileUploads = [];
    this.activeRunsBySession.set(nextSessionId, ctx);
    this.bridge.trace({
      msg_id: ctx.msgId,
      ...withSessionFields({}, ctx),
      task_id: ctx.source.event.task_id,
      channel_id: ctx.source.channelId,
      run_id: nextSessionId,
      stream: "acp",
      seq: ++ctx.traceSeq,
      phase: "provider_session_rotated",
      status: "running",
      title: "ACP session rotated",
      message: "Retrying with a fresh ACP session after a non-persisted OpenAI item reference.",
      data: { previous_session_id: previousSessionId },
    });
    this.tracePromptStarted(ctx);
    try {
      await this.runAcpPromptToCompletion(ctx);
    } catch (err) {
      if (isNonPersistedOpenAIItemError(err)) {
        await this.forgetAcpSession(ctx.providerSessionKey, ctx.acpSessionId);
      }
      throw err;
    }
  }

  private handleCancel(msgId: string, reason?: string): void {
    const ctx = this.activeRunsByMsg.get(msgId);
    if (!ctx) return;
    this.logger.warn("acp account=%s cancelling session=%s reason=%s", this.accountId, ctx.acpSessionId, reason ?? "");
    this.agent.cancel(ctx.acpSessionId);
  }

  private async handleAcpPermissionRequest(params: unknown): Promise<AcpPermissionOutcome> {
    const sessionId = isObject(params) && typeof params.sessionId === "string" ? params.sessionId : "";
    const ctx = sessionId ? this.activeRunsBySession.get(sessionId) : undefined;
    if (!ctx) {
      this.logger.warn("acp account=%s permission request has no active run session=%s", this.accountId, sessionId);
      return { outcome: "cancelled" };
    }

    const requestId = randomUUID();
    const title = permissionTitle(params);
    const body = permissionBody(params);
    const options = permissionOptions(params);
    const ack = await this.bridge.requestPermission({
      channelId: ctx.source.channelId,
      requestId,
      taskId: ctx.source.event.task_id,
      msgId: ctx.msgId,
      acpSessionId: ctx.acpSessionId,
      providerSessionKey: ctx.providerSessionKey,
      providerSessionId: ctx.acpSessionId,
      sessionId: ctx.sourceSessionId,
      title,
      body,
      tool: permissionToolName(params),
      options,
    });
    if (!ack.ok) {
      this.logger.warn(
        "acp account=%s permission request card rejected request_id=%s code=%s error=%s",
        this.accountId,
        requestId,
        ack.code,
        ack.error,
      );
      return { outcome: "cancelled" };
    }

    this.bridge.trace({
      msg_id: ctx.msgId,
      task_id: ctx.source.event.task_id,
      channel_id: ctx.source.channelId,
      run_id: ctx.acpSessionId,
      ...withSessionFields({}, ctx),
      stream: "acp",
      seq: ++ctx.traceSeq,
      phase: "permission_requested",
      status: "waiting",
      title: "ACP permission requested",
      message: title,
      data: {
        request_id: requestId,
        message_id: ack.messageId,
        options,
      },
    });

    if (ack.permissionResolution) {
      return this.permissionOutcomeFromResolution(ctx, params, {
        ...ack.permissionResolution,
        request_id: ack.permissionResolution.request_id || requestId,
        message_id: ack.permissionResolution.message_id ?? ack.messageId ?? null,
      });
    }

    const timeoutMs = this.config.agent.promptTimeoutMs ?? this.config.agent.requestTimeoutMs ?? 900_000;
    return await new Promise<AcpPermissionOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        this.logger.warn("acp account=%s permission request timed out request_id=%s", this.accountId, requestId);
        resolve({ outcome: "cancelled" });
      }, timeoutMs);
      this.pendingPermissions.set(requestId, { ctx, params, resolve, timer });
    });
  }

  private handlePermissionResolution(resolution: PermissionResolutionInbound): void {
    const pending = this.pendingPermissions.get(resolution.request_id);
    if (!pending) return;
    this.pendingPermissions.delete(resolution.request_id);
    clearTimeout(pending.timer);
    pending.resolve(this.permissionOutcomeFromResolution(pending.ctx, pending.params, resolution));
  }

  private permissionOutcomeFromResolution(
    ctx: RunContext,
    params: unknown,
    resolution: PermissionResolutionInbound & { outcome?: "selected" | "cancelled" },
  ): AcpPermissionOutcome {
    const optionId = resolution.outcome === "cancelled"
      ? null
      : resolution.option_id || permissionOptionIdForResolution(params, resolution.resolution);
    const outcome: AcpPermissionOutcome = resolution.outcome === "cancelled"
      ? { outcome: "cancelled" }
      : optionId
      ? { outcome: "selected", optionId }
      : { outcome: "cancelled" };
    this.bridge.trace({
      msg_id: ctx.msgId,
      task_id: ctx.source.event.task_id,
      channel_id: ctx.source.channelId,
      run_id: ctx.acpSessionId,
      ...withSessionFields({}, ctx),
      stream: "acp",
      seq: ++ctx.traceSeq,
      phase: "permission_resolved",
      status: resolution.resolution === "allow" ? "approved" : "denied",
      title: "ACP permission resolved",
      message: resolution.resolution,
      data: {
        request_id: resolution.request_id,
        message_id: resolution.message_id ?? null,
        resolved_by: resolution.resolved_by ?? null,
        option_id: optionId,
      },
    });
    return outcome;
  }

  private resolveConfigOptionTarget(update: ConfigOptionSetInbound): {
    sessionId: string | null;
    providerSessionKey: string | null;
  } {
    let sessionId = typeof update.session_id === "string" && update.session_id.trim()
      ? update.session_id.trim()
      : null;
    let providerSessionKey = typeof update.provider_session_key === "string" && update.provider_session_key.trim()
      ? update.provider_session_key.trim()
      : null;
    if (!sessionId && providerSessionKey) {
      sessionId = this.activeProviderSessions.get(providerSessionKey) ?? null;
    }
    if (!providerSessionKey && sessionId) {
      providerSessionKey = this.providerSessionKeysByAcpSession.get(sessionId) ?? null;
    }
    if (!sessionId && typeof this.discoveredOptions?.sessionId === "string") {
      sessionId = this.discoveredOptions.sessionId;
      providerSessionKey = providerSessionKey
        ?? (typeof this.discoveredOptions.providerSessionKey === "string" ? this.discoveredOptions.providerSessionKey : null);
    }
    return { sessionId, providerSessionKey };
  }

  private markKnownConfigOptionValue(
    providerSessionKey: string | null,
    sessionId: string,
    configId: string,
    value: string,
  ): void {
    if (!Array.isArray(this.discoveredOptions?.configOptions)) return;
    let changed = false;
    const configOptions = this.discoveredOptions.configOptions.map((option) => {
      if (!isObject(option) || String(option["id"] ?? "") !== configId) return option;
      changed = true;
      return { ...option, currentValueId: value };
    });
    if (changed) this.reportAcpDiscoveredOptions(providerSessionKey, sessionId, { configOptions });
  }

  private async handleConfigOptionSet(update: ConfigOptionSetInbound): Promise<void> {
    const requestId = typeof update.request_id === "string" ? update.request_id : null;
    const configId = typeof update.config_id === "string" ? update.config_id.trim() : "";
    const value = typeof update.value === "string" ? update.value.trim() : "";
    const target = this.resolveConfigOptionTarget(update);
    const base = {
      request_id: requestId,
      session_id: target.sessionId,
      provider_session_key: target.providerSessionKey,
      config_id: configId || null,
      value: value || null,
    };
    if (!target.sessionId || !configId || !value) {
      this.bridge.sendConfigOptionStatus({
        ...base,
        ok: false,
        error: "session_id, config_id, and value are required",
      });
      return;
    }
    try {
      const result = await this.agent.setSessionConfigOption(target.sessionId, configId, value);
      if (hasOwn(result, "configOptions")) {
        this.reportAcpDiscoveredOptions(target.providerSessionKey, target.sessionId, result);
      } else {
        this.markKnownConfigOptionValue(target.providerSessionKey, target.sessionId, configId, value);
      }
      const options = this.discoveredOptions ? normalizeDiscoveredOptions(this.discoveredOptions) : null;
      this.bridge.sendConfigOptionStatus({
        ...base,
        ok: true,
        options,
      });
      this.logger.info(
        "acp account=%s set config option session=%s config_id=%s",
        this.accountId,
        target.sessionId,
        configId,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.bridge.sendConfigOptionStatus({
        ...base,
        ok: false,
        error: detail,
      });
      this.logger.warn(
        "acp account=%s set config option failed session=%s config_id=%s: %s",
        this.accountId,
        target.sessionId,
        configId,
        detail,
      );
    }
  }

  private async handleConfigUpdate(update: ConfigUpdateInbound): Promise<void> {
    const normalized = await normalizeRemoteSettings(update.settings, this.config.agent.cwd);
    const hasConfigOptionsSetting = hasOwn(normalized.settings as Record<string, unknown>, "configOptions");
    const nextConfigOptions = normalized.settings.configOptions ?? {};
    const nextConfigOptionsKey = acpConfigOptionsKey(nextConfigOptions);
    const configOptionsChanged = hasConfigOptionsSetting && nextConfigOptionsKey !== this.desiredAcpConfigOptionsKey;
    const isOpenCode = isOpenCodeAcpCommand(this.config.agent.command);
    const runtimeSettings: RemoteConnectorSettings = { ...normalized.settings };
    if (isOpenCode) delete runtimeSettings.agentNativePermissionMode;
    const applied = this.agent.updateRuntimeSettings(runtimeSettings);
    normalized.applied = applied;
    if (configOptionsChanged) {
      this.desiredAcpConfigOptions = nextConfigOptions;
      this.desiredAcpConfigOptionsKey = nextConfigOptionsKey;
      const rejected = await this.applyDesiredConfigOptionsToActiveSessions();
      normalized.rejected.push(...rejected);
      if (rejected.length === 0) applied.push("configOptions");
    }
    const restartSettings: RemoteConnectorSettings = {};
    const restartFields: string[] = [];
    if (normalized.settings.cwd) {
      restartSettings.cwd = normalized.settings.cwd;
      restartFields.push("cwd");
    }
    if (normalized.settings.model) {
      if (isOpenCode) {
        restartSettings.model = normalized.settings.model;
        restartFields.push("model");
      } else {
        normalized.rejected.push({
          field: "model",
          reason: "model switching is only supported for OpenCode ACP",
        });
      }
    }
    if (normalized.settings.agentNativePermissionMode) {
      const nativeMode = normalized.settings.agentNativePermissionMode;
      if (isOpenCode && !openCodePermissionForNativeMode(nativeMode)) {
        normalized.rejected.push({
          field: "agentNativePermissionMode",
          reason: "OpenCode native permission mode must be ask, allow, deny, or reject",
        });
      } else if (isOpenCode) {
        restartSettings.agentNativePermissionMode = nativeMode;
        restartFields.push("agentNativePermissionMode");
      }
    }
    if (restartFields.length > 0) {
      if (this.activeRunsByMsg.size > 0) {
        for (const field of restartFields) {
          normalized.rejected.push({ field, reason: "cannot restart ACP agent while a prompt is running" });
        }
      } else {
        const previous = {
          args: [...(this.config.agent.args ?? [])],
          cwd: this.config.agent.cwd,
          model: this.config.agent.model,
          env: this.config.agent.env ? { ...this.config.agent.env } : undefined,
          agentNativePermissionMode: this.config.agent.agentNativePermissionMode,
        };
        try {
          if (restartSettings.cwd) this.config.agent.cwd = restartSettings.cwd;
          if (restartSettings.model) {
            this.config.agent.model = restartSettings.model;
            this.config.agent.env = withOpenCodeModelEnv(this.config.agent.env, restartSettings.model);
          }
          if (restartSettings.agentNativePermissionMode) {
            this.config.agent.agentNativePermissionMode = restartSettings.agentNativePermissionMode;
            this.config.agent.env = withOpenCodePermissionEnv(
              this.config.agent.env,
              restartSettings.agentNativePermissionMode,
            );
          }
          await this.agent.restart();
          this.activeProviderSessions.clear();
          this.providerSessionKeysByAcpSession.clear();
          this.configOptionsBySession.clear();
          this.discoveredOptions = null;
          this.reportAcpDiscoveredOptions(null, null, {});
          applied.push(...restartFields);
          this.logger.info(
            "acp account=%s restarted agent for connector config revision=%s fields=%s",
            this.accountId,
            update.revision ?? "",
            restartFields.join(","),
          );
        } catch (err) {
          this.config.agent.args = previous.args;
          this.config.agent.cwd = previous.cwd;
          this.config.agent.model = previous.model;
          this.config.agent.env = previous.env;
          this.config.agent.agentNativePermissionMode = previous.agentNativePermissionMode;
          try {
            await this.agent.restart();
          } catch (rollbackErr) {
            this.logger.error(
              "acp account=%s rollback restart failed after config update error: %s",
              this.accountId,
              String(rollbackErr),
            );
          }
          normalized.rejected.push({
            field: restartFields.join(","),
            reason: `ACP agent restart failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
    if (applied.length > 0) {
      this.logger.info(
        "acp account=%s applied connector config revision=%s fields=%s",
        this.accountId,
        update.revision ?? "",
        applied.join(","),
      );
    }
    if (normalized.rejected.length > 0) {
      this.logger.warn(
        "acp account=%s rejected connector config revision=%s fields=%s",
        this.accountId,
        update.revision ?? "",
        normalized.rejected.map((item) => item.field).join(","),
      );
    }
    this.bridge.sendConfigStatus({
      revision: update.revision ?? null,
      ok: normalized.rejected.length === 0,
      applied,
      rejected: normalized.rejected,
    });
  }

  private async handleAcpUpdate(notification: AcpSessionUpdate): Promise<void> {
    const update = notification.update;
    const kind = String(update.sessionUpdate ?? "unknown");
    let reportPayload = update;
    if (kind === "config_option_update" && hasOwn(update, "configOptions")) {
      const options = this.updateSessionConfigOptions(notification.sessionId, update.configOptions);
      if (options) reportPayload = { ...update, configOptions: options };
      this.reportAcpDiscoveredOptions(
        this.providerSessionKeysByAcpSession.get(notification.sessionId) ?? null,
        notification.sessionId,
        reportPayload,
      );
      const rejected = await this.applyDesiredSessionConfigOptions(notification.sessionId, options);
      for (const item of rejected) {
        this.logger.warn("acp account=%s rejected ACP session config %s: %s", this.accountId, item.field, item.reason);
      }
    }
    if (
      kind === "config_option_update" ||
      kind === "current_mode_update" ||
      kind === "available_commands_update"
    ) {
      if (kind !== "config_option_update" || !hasOwn(update, "configOptions")) {
        this.reportAcpDiscoveredOptions(
          this.providerSessionKeysByAcpSession.get(notification.sessionId) ?? null,
          notification.sessionId,
          reportPayload,
        );
      }
    }
    const ctx = this.activeRunsBySession.get(notification.sessionId);
    if (!ctx) return;
    if (kind === "agent_message_chunk") {
      const text = textOfContent(update.content);
      if (text) {
        ctx.text += text;
        ctx.sentDelta = true;
        this.bridge.streamDelta({
          msgId: ctx.msgId,
          seq: ++ctx.deltaSeq,
          delta: text,
          sessionId: ctx.sourceSessionId,
          providerSessionId: ctx.acpSessionId,
          providerSessionKey: ctx.providerSessionKey,
        });
      }
      const upload = this.uploadAcpFiles(ctx, update.content);
      ctx.pendingFileUploads.push(upload);
      await upload;
      return;
    }
    const message = kind === "agent_thought_chunk"
      ? textOfContent(update.content)
      : summarizeUpdate(update);
    this.bridge.trace({
      msg_id: ctx.msgId,
      ...withSessionFields({}, ctx),
      task_id: ctx.source.event.task_id,
      channel_id: ctx.source.channelId,
      run_id: ctx.acpSessionId,
      stream: "acp",
      seq: ++ctx.traceSeq,
      phase: kind,
      status: String(update.status ?? "running"),
      title: String(update.title ?? kind),
      message,
      data: update,
    });
  }

  private async uploadAcpFiles(ctx: RunContext, content: unknown): Promise<void> {
    const files = await extractFilesFromContent(
      content,
      this.config.agent.cwd,
      "acp-output.bin",
      { textMinMtimeMs: ctx.startedAtMs - 5000 },
    );
    await this.uploadFiles(ctx, files);
  }

  private async uploadTextLinkedFiles(ctx: RunContext): Promise<void> {
    const files = await extractFilesFromTextLinks(ctx.text, this.config.agent.cwd, ctx.startedAtMs - 5000);
    await this.uploadFiles(ctx, files);
  }

  private async uploadFiles(ctx: RunContext, files: ExtractedFile[]): Promise<void> {
    for (const file of files) {
      if (ctx.ignoredOutputFileKeys.has(file.key)) continue;
      if (ctx.seenFileKeys.has(file.key)) continue;
      ctx.seenFileKeys.add(file.key);
      try {
        const uploaded = await uploadBridgeBinaryFileHttp(
          ctx.httpBase,
          ctx.botToken,
          ctx.source.channelId,
          file,
          this.config.advanced?.sendAckTimeoutMs ?? 10 * 60_000,
        );
        if (uploaded) {
          this.recordUploadedFile(ctx, uploaded);
          continue;
        }
      } catch (err) {
        if (err instanceof BridgeHttpUploadError && ![404, 405].includes(err.status)) {
          this.logger.warn(
            "acp account=%s HTTP file upload rejected filename=%s error=%s",
            this.accountId,
            file.filename,
            err.message,
          );
          continue;
        }
        this.logger.warn(
          "acp account=%s HTTP file upload failed; falling back to WS filename=%s error=%s",
          this.accountId,
          file.filename,
          String(err),
        );
      }
      const ack = await this.uploadFileWithRetry(ctx, file);
      if (ack.ok) {
        this.recordUploadedFile(ctx, ack);
      } else {
        this.logger.warn(
          "acp account=%s file upload failed filename=%s code=%s error=%s",
          this.accountId,
          file.filename,
          ack.code,
          ack.error,
        );
      }
    }
  }

  private recordUploadedFile(ctx: RunContext, file: BridgeUploadedFile): void {
    ctx.fileIds.push(file.file_id);
    this.bridge.trace({
      msg_id: ctx.msgId,
      ...withSessionFields({}, ctx),
      task_id: ctx.source.event.task_id,
      channel_id: ctx.source.channelId,
      run_id: ctx.acpSessionId,
      stream: "acp",
      seq: ++ctx.traceSeq,
      phase: "file_uploaded",
      status: "completed",
      title: "ACP file uploaded",
      message: file.filename,
      data: {
        file_id: file.file_id,
        filename: file.filename,
        content_type: file.content_type,
        size_bytes: file.size_bytes,
        preview_url: file.preview_url,
        download_url: file.download_url,
      },
    });
  }

  private async uploadFileWithRetry(ctx: RunContext, file: ExtractedFile) {
    const transientCodes = new Set(["ws_not_open", "ws_send_failed", "session_closed"]);
    let lastAck = await this.bridge.uploadFile({
      channelId: ctx.source.channelId,
      filename: file.filename,
      data: file.data,
      contentType: file.contentType,
    });
    for (let attempt = 1; !lastAck.ok && transientCodes.has(lastAck.code) && attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      this.bridge.trace({
      msg_id: ctx.msgId,
      ...withSessionFields({}, ctx),
      task_id: ctx.source.event.task_id,
      channel_id: ctx.source.channelId,
      run_id: ctx.acpSessionId,
      stream: "acp",
      seq: ++ctx.traceSeq,
      phase: "file_upload_retry",
        status: "running",
        title: "Retrying ACP file upload",
        message: `${file.filename}: ${lastAck.code}`,
      });
      lastAck = await this.bridge.uploadFile({
        channelId: ctx.source.channelId,
        filename: file.filename,
        data: file.data,
        contentType: file.contentType,
      });
    }
    return lastAck;
  }
}

export class ConnectorRuntime {
  private accounts: AcpBridgeAccount[];

  constructor(
    configs: Record<string, AccountConfig>,
    private readonly state: SessionStateStore,
    private readonly logger: Logger = console,
  ) {
    this.accounts = Object.entries(configs).map(
      ([id, config]) => new AcpBridgeAccount(id, config, state, logger),
    );
  }

  async start(): Promise<void> {
    await this.state.load();
    await Promise.all(this.accounts.map((account) => account.start()));
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.accounts.map((account) => account.stop()));
  }
}
