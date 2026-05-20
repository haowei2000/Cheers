import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BotSession, type AttachmentInfo, type ConfigUpdateInbound, type InboundMessage } from "@haowei0520/bridge-client";

import { AcpStdioAgent } from "./acp-agent.js";
import { SessionStateStore } from "./state.js";
import type {
  AccountConfig,
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
}

interface PromptBuildOptions {
  httpBase: string;
  botToken: string;
  supportsImages: boolean;
  supportsEmbeddedContext: boolean;
  logger: Logger;
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

interface BridgeUploadedFile {
  file_id: string;
  filename: string;
  content_type?: string;
  size_bytes?: number;
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
  pendingFileUploads: Promise<void>[];
}

interface SettingsApplyResult {
  applied: string[];
  rejected: Array<{ field: string; reason: string }>;
  settings: RemoteConnectorSettings;
}

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
  ".txt",
  ".webp",
  ".wps",
  ".xls",
  ".xlsx",
  ".xml",
  ".zip",
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
  if (hasOwn(next, "configOptions")) next.configOptions = capArray(next.configOptions, 100);
  if (hasOwn(next, "availableCommands")) next.availableCommands = capArray(next.availableCommands, 100);
  return next;
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
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".htm": "text/html",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xml": "application/xml",
    ".zip": "application/zip",
  };
  return types[ext] ?? undefined;
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

function isInsideDir(filePath: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(filePath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function filenameFromRecord(record: Record<string, unknown>, fallback: string): string {
  const direct = record.filename ?? record.name ?? record.title ?? record.path ?? record.filePath ?? record.uri;
  return typeof direct === "string" && direct.trim() ? safeFilename(direct) : fallback;
}

function inlineFileFromRecord(record: Record<string, unknown>, fallbackName: string): ExtractedFile | null {
  const filename = filenameFromRecord(record, fallbackName);
  const contentType = guessContentType(
    filename,
    typeof record.mimeType === "string"
      ? record.mimeType
      : typeof record.contentType === "string"
        ? record.contentType
        : undefined,
  );
  const text = typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : null;
  if (text !== null) {
    return {
      key: `text:${filename}:${text.length}:${text.slice(0, 128)}`,
      filename,
      contentType: contentType ?? "text/plain",
      data: Buffer.from(text, "utf8"),
    };
  }
  const blob = typeof record.blob === "string"
    ? record.blob
    : typeof record.data_b64 === "string"
      ? record.data_b64
      : typeof record.data === "string"
        ? record.data
        : null;
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
  return fileFromPath(fileURLToPath(uri), cwd, resource);
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
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  if (options.minMtimeMs !== undefined && info.mtimeMs + 1000 < options.minMtimeMs) return null;
  const filename = filenameFromRecord(resource, safeFilename(filePath));
  return {
    key: `file:${path.resolve(filePath)}:${info.mtimeMs}:${info.size}`,
    filename,
    contentType: guessContentType(
      filename,
      typeof resource.mimeType === "string" ? resource.mimeType : undefined,
    ),
    data: await readFile(filePath),
  };
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
    || block.type === "resource"
    || typeof block.blob === "string"
    || typeof block.data_b64 === "string"
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

function providerSessionKeyOf(message: InboundMessage): string {
  const event = message.event;
  const fromEvent = event.provider_session_key;
  const fromSession = event.session?.provider_session_key;
  if (typeof fromEvent === "string" && fromEvent) return fromEvent;
  if (typeof fromSession === "string" && fromSession) return fromSession;
  return `channel:${message.channelId}`;
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

function isImageAttachment(attachment: AttachmentInfo): boolean {
  return String(attachment.content_type || "").toLowerCase().startsWith("image/");
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "reject" || value === "allow" || value === "cancel";
}

function pickTimeoutMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < REMOTE_TIMEOUT_MIN_MS || rounded > REMOTE_TIMEOUT_MAX_MS) return null;
  return rounded;
}

function isCodexAcpCommand(command: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === "codex-acp" || base === "codex-acp.exe";
}

function codexModelConfigArg(model: string): string {
  return `model=${JSON.stringify(model)}`;
}

function withCodexModelArg(args: string[] | undefined, model: string): string[] {
  const next: string[] = [];
  const current = args ?? [];
  for (let i = 0; i < current.length; i += 1) {
    const arg = current[i];
    const following = current[i + 1];
    if ((arg === "-c" || arg === "--config") && typeof following === "string" && following.startsWith("model=")) {
      i += 1;
      continue;
    }
    if (arg.startsWith("--config=model=")) {
      continue;
    }
    next.push(arg);
  }
  next.push("-c", codexModelConfigArg(model));
  return next;
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
  if ("permissionMode" in raw) {
    if (isPermissionMode(raw.permissionMode)) {
      settings.permissionMode = raw.permissionMode;
    } else {
      rejected.push({ field: "permissionMode", reason: "must be reject, allow, or cancel" });
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
  return { applied: [], rejected, settings };
}

function attachmentUri(attachment: AttachmentInfo): string {
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
  if (!response.ok) return null;
  const body = await response.json() as { data?: unknown };
  return body.data && typeof body.data === "object" ? body.data as Record<string, unknown> : null;
}

async function fetchBridgeTextFile(
  httpBase: string,
  botToken: string,
  attachment: AttachmentInfo,
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
  attachment: AttachmentInfo,
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
  attachment: AttachmentInfo,
  options: PromptBuildOptions,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  if (!attachment.file_id) return blocks;

  if (isImageAttachment(attachment)) {
    if (options.supportsImages) {
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
      } catch (err) {
        options.logger.warn("acp attachment image hydration failed file_id=%s: %s", attachment.file_id, String(err));
      }
    }
    if (attachment.summary) {
      blocks.push({ type: "text", text: `[Image attachment unavailable: ${attachment.filename || attachment.file_id}]\n${attachment.summary}` });
    }
    return blocks;
  }

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

  if (attachment.summary) {
    blocks.push({
      type: "text",
      text: `--- Attachment summary: ${attachment.filename || attachment.file_id} ---\n${attachment.summary}\n--- End attachment summary ---`,
    });
  }
  return blocks;
}

async function buildPrompt(message: InboundMessage, options: PromptBuildOptions): Promise<ContentBlock[]> {
  const parts: string[] = [];
  if (message.text.trim()) parts.push(message.text.trim());
  const memory = message.event.memory_context ?? {};
  if (Object.keys(memory).length > 0) {
    parts.push(
      [
        "<agentnexus_memory>",
        ...Object.entries(memory).map(([key, value]) => `<${key}>\n${value}\n</${key}>`),
        "</agentnexus_memory>",
      ].join("\n"),
    );
  }
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
  private discoveredOptions: AcpDiscoveredOptions | null = null;

  constructor(
    private readonly accountId: string,
    private readonly config: AccountConfig,
    private readonly state: SessionStateStore,
    private readonly logger: Logger,
  ) {
    this.agent = new AcpStdioAgent(accountId, config.agent, logger);
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
        onFatal: (reason) => this.logger.error("bridge account=%s fatal: %s", this.accountId, reason),
        onError: (err) => this.logger.error("bridge account=%s error: %s", this.accountId, String(err)),
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
    await Promise.allSettled([this.bridge.stop(), this.agent.stop()]);
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
    if (hasOwn(payload, "configOptions")) next.configOptions = payload.configOptions;
    if (hasOwn(payload, "availableCommands")) next.availableCommands = payload.availableCommands;

    const kind = typeof payload.sessionUpdate === "string" ? payload.sessionUpdate : "";
    if (kind === "current_mode_update" && typeof payload.currentModeId === "string") {
      next.modes = {
        ...(isObject(next.modes) ? next.modes : {}),
        currentModeId: payload.currentModeId,
      };
    }
    if (kind === "config_option_update" && hasOwn(payload, "configOptions")) {
      next.configOptions = payload.configOptions;
    }
    if (kind === "available_commands_update" && hasOwn(payload, "availableCommands")) {
      next.availableCommands = payload.availableCommands;
    }

    this.discoveredOptions = next;
    if (!this.bridge.sendConfigOptions({ options: normalizeDiscoveredOptions(next) })) {
      this.logger.debug?.("bridge account=%s skipped config_options; control stream is not open", this.accountId);
    }
  }

  private enqueueMessage(message: InboundMessage): void {
    const providerSessionKey = providerSessionKeyOf(message);
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
        this.reportAcpDiscoveredOptions(providerSessionKey, saved, loaded);
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
    const created = await this.agent.newSession();
    this.activeProviderSessions.set(providerSessionKey, created.sessionId);
    this.providerSessionKeysByAcpSession.set(created.sessionId, providerSessionKey);
    await this.state.set(this.accountId, providerSessionKey, created.sessionId);
    this.reportAcpDiscoveredOptions(providerSessionKey, created.sessionId, created);
    this.logger.info("acp account=%s created session %s for %s", this.accountId, created.sessionId, providerSessionKey);
    return created.sessionId;
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    const providerSessionKey = providerSessionKeyOf(message);
    const acpSessionId = await this.ensureAcpSession(providerSessionKey);
    const msgId = message.event.placeholder_msg_id || `${message.event.task_id}`;
    const ctx: RunContext = {
      source: message,
      providerSessionKey,
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
      pendingFileUploads: [],
    };
    this.activeRunsBySession.set(acpSessionId, ctx);
    this.activeRunsByMsg.set(msgId, ctx);
    this.bridge.trace({
      msg_id: msgId,
      task_id: message.event.task_id,
      channel_id: message.channelId,
      run_id: acpSessionId,
      session_key: providerSessionKey,
      stream: "acp",
      seq: ++ctx.traceSeq,
      phase: "prompt_started",
      status: "running",
      title: "ACP prompt started",
      message: this.config.agent.command,
    });
    try {
      const capabilities = this.agent.initializeResponse?.agentCapabilities?.promptCapabilities ?? {};
      const result = await this.agent.prompt(acpSessionId, await buildPrompt(message, {
        httpBase: deriveHttpBase(this.config.dataUrl),
        botToken: this.config.botToken,
        supportsImages: capabilities.image === true,
        supportsEmbeddedContext: capabilities.embeddedContext === true,
        logger: this.logger,
      }));
      await this.uploadTextLinkedFiles(ctx);
      await Promise.allSettled(ctx.pendingFileUploads);
      this.bridge.trace({
        msg_id: msgId,
        task_id: message.event.task_id,
        channel_id: message.channelId,
        run_id: acpSessionId,
        session_key: providerSessionKey,
        stream: "acp",
        seq: ++ctx.traceSeq,
        phase: "prompt_finished",
        status: result.stopReason === "cancelled" ? "cancelled" : "completed",
        title: "ACP prompt finished",
        message: result.stopReason ?? "end_turn",
      });
      if (message.event.placeholder_msg_id) {
        const ack = await this.bridge.streamDone({ msgId, fileIds: ctx.fileIds });
        if (!ack.ok) {
          this.logger.warn(
            "acp account=%s stream done not acknowledged msg_id=%s code=%s error=%s",
            this.accountId,
            msgId,
            ack.code,
            ack.error,
          );
        }
      } else {
        await this.bridge.reply({
          source: message,
          text: ctx.text || `[ACP completed: ${result.stopReason ?? "end_turn"}]`,
          fileIds: ctx.fileIds,
        });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (message.event.placeholder_msg_id) {
        const ack = await this.bridge.streamError({ msgId, message: detail });
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
        await this.bridge.reply({ source: message, text: `ACP agent error: ${detail}` });
      }
      throw err;
    } finally {
      this.activeRunsBySession.delete(acpSessionId);
      this.activeRunsByMsg.delete(msgId);
    }
  }

  private handleCancel(msgId: string, reason?: string): void {
    const ctx = this.activeRunsByMsg.get(msgId);
    if (!ctx) return;
    this.logger.warn("acp account=%s cancelling session=%s reason=%s", this.accountId, ctx.acpSessionId, reason ?? "");
    this.agent.cancel(ctx.acpSessionId);
  }

  private async handleConfigUpdate(update: ConfigUpdateInbound): Promise<void> {
    const normalized = await normalizeRemoteSettings(update.settings, this.config.agent.cwd);
    const applied = this.agent.updateRuntimeSettings(normalized.settings);
    normalized.applied = applied;
    const restartSettings: RemoteConnectorSettings = {};
    const restartFields: string[] = [];
    if (normalized.settings.cwd) {
      restartSettings.cwd = normalized.settings.cwd;
      restartFields.push("cwd");
    }
    if (normalized.settings.model) {
      if (isCodexAcpCommand(this.config.agent.command)) {
        restartSettings.model = normalized.settings.model;
        restartFields.push("model");
      } else {
        normalized.rejected.push({
          field: "model",
          reason: "model switching is only supported for codex-acp",
        });
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
        };
        try {
          if (restartSettings.cwd) this.config.agent.cwd = restartSettings.cwd;
          if (restartSettings.model) {
            this.config.agent.model = restartSettings.model;
            this.config.agent.args = withCodexModelArg(this.config.agent.args, restartSettings.model);
          }
          await this.agent.restart();
          this.activeProviderSessions.clear();
          this.providerSessionKeysByAcpSession.clear();
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
    if (
      kind === "config_option_update" ||
      kind === "current_mode_update" ||
      kind === "available_commands_update"
    ) {
      this.reportAcpDiscoveredOptions(
        this.providerSessionKeysByAcpSession.get(notification.sessionId) ?? null,
        notification.sessionId,
        update,
      );
    }
    const ctx = this.activeRunsBySession.get(notification.sessionId);
    if (!ctx) return;
    if (kind === "agent_message_chunk") {
      const text = textOfContent(update.content);
      if (text) {
        ctx.text += text;
        ctx.sentDelta = true;
        this.bridge.streamDelta({ msgId: ctx.msgId, seq: ++ctx.deltaSeq, delta: text });
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
      task_id: ctx.source.event.task_id,
      channel_id: ctx.source.channelId,
      run_id: ctx.acpSessionId,
      session_key: ctx.providerSessionKey,
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
      const ack = await this.bridge.uploadFile({
        channelId: ctx.source.channelId,
        filename: file.filename,
        data: file.data,
        contentType: file.contentType,
      });
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
      task_id: ctx.source.event.task_id,
      channel_id: ctx.source.channelId,
      run_id: ctx.acpSessionId,
      session_key: ctx.providerSessionKey,
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
      },
    });
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
