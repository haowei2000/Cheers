import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ImgHTMLAttributes,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AppIcon, FileTypeIcon } from "./components/icons";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import http from "highlight.js/lib/languages/http";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("http", http);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerAliases(["js", "jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["sh", "zsh"], { languageName: "bash" });
hljs.registerAliases(["html", "svg"], { languageName: "xml" });
hljs.registerAliases(["yml"], { languageName: "yaml" });

// ── @mention preprocessing ───────────────────────────────────────────────────

/**
 * Replace @username patterns (outside code blocks/fences) with markdown links
 * using a `mention://` scheme so the custom `a` renderer can style them.
 */
function preprocessMentions(text: string): string {
  // Split on code fences (```…```) and inline code (`…`) to skip them
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? part // inside code — leave untouched
        : part.replace(/@([a-zA-Z0-9_\-'\u4e00-\u9fff]+)/g, "[@$1](mention://$1)")
    )
    .join("");
}

// ── AgentNexus file URL detection ────────────────────────────────────────────

/** Matches /api/files/{id}/preview|download and /api/v1/files/... URLs. */
const FILE_URL_RE = /(?:https?:\/\/[^/]+)?\/api\/(?:v1\/)?files\/([^/]+)\/(preview|download)/;

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"]);
const MAX_MARKDOWN_IMAGE_LOAD_ATTEMPTS = 5;
const HIGHLIGHT_CACHE_LIMIT = 240;
const highlightCache = new Map<string, string>();

interface MarkdownImageLoadState {
  attempt: number;
  displaySrc?: string;
  failed: boolean;
  inFlight: boolean;
  listeners: Set<() => void>;
  loaded: boolean;
}

type MarkdownImageSnapshot = Pick<MarkdownImageLoadState, "attempt" | "displaySrc" | "failed" | "loaded">;

const markdownImageLoadState = new Map<string, MarkdownImageLoadState>();

function childrenToText(children: unknown): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map((c) => childrenToText(c)).join("");
  return "";
}

function rememberHighlightedCode(key: string, value: string): string {
  if (highlightCache.has(key)) highlightCache.delete(key);
  highlightCache.set(key, value);
  while (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
    const oldestKey = highlightCache.keys().next().value;
    if (oldestKey === undefined) break;
    highlightCache.delete(oldestKey);
  }
  return value;
}

function highlightCode(codeText: string, lang: string): string {
  const key = `${lang}\n${codeText}`;
  const cached = highlightCache.get(key);
  if (cached !== undefined) {
    highlightCache.delete(key);
    highlightCache.set(key, cached);
    return cached;
  }

  try {
    const highlighted =
      lang && hljs.getLanguage(lang)
        ? hljs.highlight(codeText, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(codeText).value;
    return rememberHighlightedCode(key, highlighted);
  } catch {
    return rememberHighlightedCode(key, codeText);
  }
}

function withRetryParam(src: string, attempt: number): string {
  if (attempt <= 1) return src;
  try {
    const base = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const url = new URL(src, base);
    url.searchParams.set("_preview_retry", String(attempt));
    return src.startsWith("/") ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  } catch {
    const joiner = src.includes("?") ? "&" : "?";
    return `${src}${joiner}_preview_retry=${attempt}`;
  }
}

function createMarkdownImageState(): MarkdownImageLoadState {
  return {
    attempt: 1,
    failed: false,
    inFlight: false,
    listeners: new Set(),
    loaded: false,
  };
}

function pruneMarkdownImageStateCache() {
  while (markdownImageLoadState.size > 200) {
    let pruned = false;
    for (const [key, state] of markdownImageLoadState) {
      if (!state.inFlight && state.listeners.size === 0) {
        markdownImageLoadState.delete(key);
        pruned = true;
        break;
      }
    }
    if (!pruned) break;
  }
}

function getRememberedImageState(src: string): MarkdownImageLoadState {
  let state = markdownImageLoadState.get(src);
  if (!state) {
    state = createMarkdownImageState();
    markdownImageLoadState.set(src, state);
    pruneMarkdownImageStateCache();
  }
  return state;
}

function snapshotMarkdownImageState(src: string): MarkdownImageSnapshot {
  const { attempt, displaySrc, failed, loaded } = getRememberedImageState(src);
  return { attempt, displaySrc, failed, loaded };
}

function notifyMarkdownImageState(state: MarkdownImageLoadState) {
  state.listeners.forEach((listener) => listener());
}

function subscribeMarkdownImageState(src: string, listener: () => void): () => void {
  const state = getRememberedImageState(src);
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

function loadMarkdownImagePreview(src: string) {
  if (typeof window === "undefined") return;

  const state = getRememberedImageState(src);
  if (state.loaded || state.failed || state.inFlight) return;

  state.inFlight = true;
  notifyMarkdownImageState(state);

  const attempt = state.attempt;
  const displaySrc = withRetryParam(src, attempt);
  const image = new Image();

  image.onload = () => {
    state.displaySrc = displaySrc;
    state.failed = false;
    state.inFlight = false;
    state.loaded = true;
    notifyMarkdownImageState(state);
  };

  image.onerror = () => {
    state.inFlight = false;
    state.loaded = false;
    if (attempt >= MAX_MARKDOWN_IMAGE_LOAD_ATTEMPTS) {
      state.failed = true;
    } else {
      state.attempt = attempt + 1;
    }
    notifyMarkdownImageState(state);
    loadMarkdownImagePreview(src);
  };

  image.src = displaySrc;
}

interface MarkdownImageProps
  extends Omit<
    ImgHTMLAttributes<HTMLImageElement>,
    "alt" | "onClick" | "onError" | "onLoad" | "src"
  > {
  src?: string;
  alt?: string;
  onImageClick?: (src: string) => void;
}

function MarkdownImage({ src, alt, onImageClick, ...props }: MarkdownImageProps) {
  const safe = src && (src.startsWith("/") || src.startsWith("http://") || src.startsWith("https://"));
  const safeSrc = safe ? src : "";
  const [loadState, setLoadState] = useState<MarkdownImageSnapshot>(() =>
    safeSrc ? snapshotMarkdownImageState(safeSrc) : { attempt: 1, failed: true, loaded: false }
  );

  useEffect(() => {
    if (!safeSrc) {
      setLoadState({ attempt: 1, failed: true, loaded: false });
      return;
    }

    const sync = () => setLoadState(snapshotMarkdownImageState(safeSrc));
    const unsubscribe = subscribeMarkdownImageState(safeSrc, sync);
    sync();
    loadMarkdownImagePreview(safeSrc);
    return unsubscribe;
  }, [safeSrc]);

  const attempt = loadState.attempt;
  const failed = !safeSrc || loadState.failed;
  const displaySrc = loadState.displaySrc ?? "";

  const placeholder = (
    <span
      className="my-2 flex min-h-[96px] w-full max-w-[320px] items-center gap-2 rounded-lg border border-dashed border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-400"
      role={failed ? "img" : "status"}
      aria-label={failed ? alt || "image preview failed" : "image preview loading"}
    >
      <AppIcon name="image" className="h-5 w-5 flex-shrink-0 text-gray-300" />
      <span className="min-w-0 truncate">
        {failed ? "图片预览不可用" : `图片预览加载中 (${attempt}/${MAX_MARKDOWN_IMAGE_LOAD_ATTEMPTS})`}
      </span>
    </span>
  );

  if (!safeSrc || failed) return placeholder;
  if (!loadState.loaded || !displaySrc) return placeholder;

  return (
    <span className="my-2 inline-block max-w-full align-top">
      <img
        {...props}
        src={displaySrc}
        alt={alt || "image"}
        className="block max-h-[400px] max-w-full rounded-lg border border-gray-200 cursor-pointer hover:opacity-90 transition-opacity"
        loading="lazy"
        onError={() => {
          const state = getRememberedImageState(safeSrc);
          state.failed = true;
          state.inFlight = false;
          state.loaded = false;
          notifyMarkdownImageState(state);
        }}
        onClick={safeSrc && onImageClick ? () => onImageClick(safeSrc) : undefined}
      />
    </span>
  );
}

interface FileChipProps {
  href: string;
  fileId: string;
  filename: string;
  onImageClick?: (src: string) => void;
  onFileClick?: (url: string, filename: string) => void;
}

function FileChip({ href, fileId, filename, onImageClick, onFileClick }: FileChipProps) {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);
  const previewUrl = href.replace(/\/(download|preview)$/, "/preview");
  const displayName = filename && filename !== previewUrl ? filename : `file-${fileId.slice(0, 8)}`;

  const handleClick = () => {
    if (onFileClick) {
      onFileClick(previewUrl, displayName);
    } else if (isImage && onImageClick) {
      onImageClick(previewUrl);
    } else {
      window.open(previewUrl, "_blank", "noreferrer");
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-2 px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg shadow-sm max-w-full hover:bg-gray-50 active:bg-gray-100 transition-colors cursor-pointer my-0.5 align-middle"
    >
      <span className="w-7 h-7 rounded-md bg-gray-50 flex items-center justify-center flex-shrink-0">
        <FileTypeIcon filename={displayName} size={22} />
      </span>
      <span className="text-[13px] font-medium text-gray-700 truncate">{displayName}</span>
    </button>
  );
}

// ── MermaidBlock ──────────────────────────────────────────────────────────────

interface MermaidBlockProps {
  code: string;
  streaming?: boolean;
}

type MermaidTheme = "dark" | "default";

interface MermaidRenderCacheEntry {
  templateId: string;
  svg: string | null;
  error: string | null;
}

interface MermaidDisplayState {
  svg: string | null;
  error: string | null;
}

const MERMAID_RENDER_CACHE_LIMIT = 100;
const MERMAID_MAX_SOURCE_CHARS = 20_000;
const MERMAID_RENDER_TIMEOUT_MS = 3_000;
const MERMAID_RENDER_ENABLED = import.meta.env.VITE_ENABLE_MERMAID !== "0";
const MERMAID_SAFE_TAGS = new Set([
  "a",
  "circle",
  "defs",
  "desc",
  "ellipse",
  "g",
  "line",
  "linearGradient",
  "marker",
  "path",
  "polygon",
  "polyline",
  "rect",
  "span",
  "stop",
  "svg",
  "text",
  "textPath",
  "title",
  "tspan",
]);
const MERMAID_SAFE_ATTRS = new Set([
  "aria-describedby",
  "aria-label",
  "class",
  "clip-path",
  "cx",
  "cy",
  "d",
  "dominant-baseline",
  "dx",
  "dy",
  "fill",
  "fill-opacity",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "gradientUnits",
  "height",
  "href",
  "id",
  "markerHeight",
  "marker-end",
  "marker-start",
  "markerWidth",
  "offset",
  "opacity",
  "orient",
  "points",
  "preserveAspectRatio",
  "r",
  "refX",
  "refY",
  "role",
  "rx",
  "ry",
  "spreadMethod",
  "stroke",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "transform",
  "version",
  "viewBox",
  "width",
  "x",
  "x1",
  "x2",
  "xlink:href",
  "xmlns",
  "xmlns:xlink",
  "y",
  "y1",
  "y2",
]);
const mermaidRenderCache = new Map<string, MermaidRenderCacheEntry>();
const mermaidRenderPromises = new Map<string, Promise<MermaidRenderCacheEntry>>();
const emptyMermaidDisplayState: MermaidDisplayState = { svg: null, error: null };

function isSafeSvgUrl(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("#") ||
    /^https?:\/\//i.test(trimmed) ||
    /^mailto:/i.test(trimmed)
  );
}

function sanitizeMermaidSvg(svg: string): string | null {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return null;
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (document.querySelector("parsererror")) return null;

  const walker = document.createTreeWalker(
    document.documentElement,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT,
  );
  const nodesToRemove: Node[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === Node.COMMENT_NODE) {
      nodesToRemove.push(node);
      continue;
    }
    if (!(node instanceof Element)) continue;
    if (!MERMAID_SAFE_TAGS.has(node.tagName)) {
      nodesToRemove.push(node);
      continue;
    }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name;
      const lowerName = name.toLowerCase();
      const value = attr.value;
      if (
        lowerName.startsWith("on") ||
        lowerName === "style" ||
        !MERMAID_SAFE_ATTRS.has(name)
      ) {
        node.removeAttribute(name);
        continue;
      }
      if ((lowerName === "href" || lowerName === "xlink:href") && !isSafeSvgUrl(value)) {
        node.removeAttribute(name);
      }
    }
  }
  nodesToRemove.forEach((node) => node.parentNode?.removeChild(node));
  return new XMLSerializer().serializeToString(document.documentElement);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Mermaid 渲染超时")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function stripTrailingSemicolon(value: string): string {
  return value.trim().replace(/;\s*$/, "");
}

function parseJsonArrayLiteral(line: string): unknown[] | null {
  const literal = stripTrailingSemicolon(line);
  if (!literal.startsWith("[") || !literal.endsWith("]")) return null;
  try {
    const parsed = JSON.parse(literal);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isStringArrayLine(line: string): boolean {
  const parsed = parseJsonArrayLiteral(line);
  return Boolean(parsed?.length && parsed.every((item) => typeof item === "string"));
}

function numericSeriesValues(lines: string[]): number[] {
  return lines.flatMap((line) => {
    const match = /^\s*(?:bar|line)\s+(\[[^\]]+\])\s*;?\s*$/i.exec(line);
    if (!match) return [];
    const parsed = parseJsonArrayLiteral(match[1]);
    if (!parsed) return [];
    return parsed.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  });
}

function axisLimit(value: number, direction: "min" | "max"): string {
  if (direction === "min") return String(Math.floor(value));
  const rounded = Math.ceil(value);
  return String(rounded > 0 ? rounded : 1);
}

function normalizeXyChartAxisRangeLine(line: string): string {
  const number = "-?\\d+(?:\\.\\d+)?";
  const axis = "\\s*(?:x-axis|y-axis)\\b";
  const trailing = "(\\s*;?\\s*)$";
  const noLabel = new RegExp(`^(${axis})\\s+(${number})\\s+(${number})${trailing}`, "i");
  const withLabel = new RegExp(
    `^(${axis}\\s+(?:"[^"]*"|'[^']*'|[^\\s]+))\\s+(${number})\\s+(${number})${trailing}`,
    "i",
  );
  const match = noLabel.exec(line) || withLabel.exec(line);
  if (!match) return line;
  return `${match[1]} ${match[2]} --> ${match[3]}${match[4]}`;
}

function normalizeXyChartBeta(code: string): string {
  let lines = code.split(/\r?\n/);
  const chartIndex = lines.findIndex((line) => line.trim().length > 0);
  if (chartIndex < 0 || !/^xychart-beta\b/i.test(lines[chartIndex].trim())) return code;
  const normalizedLines = lines.map(normalizeXyChartAxisRangeLine);
  const axisRangeChanged = normalizedLines.some((line, index) => line !== lines[index]);
  lines = normalizedLines;

  const hasXAxis = lines.some((line) => /^\s*x-axis\b/i.test(line));
  const hasYAxis = lines.some((line) => /^\s*y-axis\b/i.test(line));
  if (hasXAxis && hasYAxis) return axisRangeChanged ? lines.join("\n") : code;

  const labelLineIndex = hasXAxis
    ? -1
    : lines.findIndex((line, index) => index > chartIndex && isStringArrayLine(line));
  if (!hasXAxis && labelLineIndex < 0) return code;

  const labelLine = labelLineIndex >= 0 ? lines[labelLineIndex] : "";
  const indent = labelLine.match(/^\s*/)?.[0] || "    ";
  const nextLines = labelLineIndex >= 0
    ? lines.filter((_, index) => index !== labelLineIndex)
    : [...lines];
  const insertLines: string[] = [];

  if (!hasXAxis) {
    insertLines.push(`${indent}x-axis ${stripTrailingSemicolon(labelLine)}`);
  }

  if (!hasYAxis) {
    const values = numericSeriesValues(nextLines);
    if (values.length > 0) {
      const min = Math.min(...values);
      const max = Math.max(...values);
      const yMin = min < 0 ? axisLimit(min * 1.1, "min") : "0";
      const yMax = axisLimit(max * 1.1, "max");
      insertLines.push(`${indent}y-axis "值" ${yMin} --> ${yMax}`);
    }
  }

  if (insertLines.length === 0) return axisRangeChanged ? lines.join("\n") : code;

  let insertIndex = chartIndex + 1;
  while (insertIndex < nextLines.length && /^\s*(title|acc_title|acc_descr)\b/i.test(nextLines[insertIndex].trim())) {
    insertIndex += 1;
  }
  nextLines.splice(insertIndex, 0, ...insertLines);
  return nextLines.join("\n");
}

function normalizeMermaidCode(code: string): string {
  return normalizeXyChartBeta(code);
}

function getMermaidTheme(): MermaidTheme {
  if (typeof document === "undefined") return "default";
  return document.documentElement.classList.contains("dark") ? "dark" : "default";
}

function mermaidCacheKey(renderCode: string, theme: MermaidTheme): string {
  return `${theme}\n${renderCode}`;
}

function hashMermaidCacheKey(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function rememberMermaidRender(key: string, entry: MermaidRenderCacheEntry) {
  if (mermaidRenderCache.has(key)) mermaidRenderCache.delete(key);
  mermaidRenderCache.set(key, entry);
  while (mermaidRenderCache.size > MERMAID_RENDER_CACHE_LIMIT) {
    const oldestKey = mermaidRenderCache.keys().next().value;
    if (oldestKey === undefined) break;
    mermaidRenderCache.delete(oldestKey);
  }
}

function getRememberedMermaidRender(key: string): MermaidRenderCacheEntry | null {
  const entry = mermaidRenderCache.get(key);
  if (!entry) return null;
  mermaidRenderCache.delete(key);
  mermaidRenderCache.set(key, entry);
  return entry;
}

function displayStateFromMermaidEntry(entry: MermaidRenderCacheEntry, id: string): MermaidDisplayState {
  return {
    svg: entry.svg ? entry.svg.split(entry.templateId).join(id) : null,
    error: entry.error,
  };
}

function initialMermaidDisplayState(renderCode: string, id: string, streaming?: boolean): MermaidDisplayState {
  if (streaming) return emptyMermaidDisplayState;
  const cached = getRememberedMermaidRender(mermaidCacheKey(renderCode, getMermaidTheme()));
  return cached ? displayStateFromMermaidEntry(cached, id) : emptyMermaidDisplayState;
}

async function renderMermaidWithCache(renderCode: string, theme: MermaidTheme): Promise<MermaidRenderCacheEntry> {
  const key = mermaidCacheKey(renderCode, theme);
  const cached = getRememberedMermaidRender(key);
  if (cached) return cached;

  const pending = mermaidRenderPromises.get(key);
  if (pending) return pending;

  const templateId = `mermaid-cache-${hashMermaidCacheKey(key)}`;
  const promise = (async () => {
    try {
      if (!MERMAID_RENDER_ENABLED) {
        throw new Error("Mermaid 渲染已关闭");
      }
      if (renderCode.length > MERMAID_MAX_SOURCE_CHARS) {
        throw new Error("Mermaid 图表过大，已跳过渲染");
      }
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({ securityLevel: "strict", startOnLoad: false, theme });
      const { svg: rendered } = await withTimeout(
        mermaid.render(templateId, renderCode),
        MERMAID_RENDER_TIMEOUT_MS,
      );
      const sanitizedSvg = sanitizeMermaidSvg(rendered);
      if (!sanitizedSvg) {
        throw new Error("Mermaid SVG 清洗失败");
      }
      const entry: MermaidRenderCacheEntry = { templateId, svg: sanitizedSvg, error: null };
      rememberMermaidRender(key, entry);
      return entry;
    } catch (e) {
      const entry: MermaidRenderCacheEntry = { templateId, svg: null, error: String(e) };
      rememberMermaidRender(key, entry);
      return entry;
    } finally {
      mermaidRenderPromises.delete(key);
    }
  })();

  mermaidRenderPromises.set(key, promise);
  return promise;
}

const MermaidBlock = memo(function MermaidBlock({ code, streaming }: MermaidBlockProps) {
  const uid = useId().replace(/:/g, "");
  const id = `mermaid-${uid}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderState, setRenderState] = useState<MermaidDisplayState>(() =>
    initialMermaidDisplayState(normalizeMermaidCode(code), id, streaming),
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renderCode = useMemo(() => normalizeMermaidCode(code), [code]);
  const { svg, error } = renderState;

  useEffect(() => {
    let cancelled = false;
    if (streaming) {
      setRenderState(emptyMermaidDisplayState);
      return () => {
        cancelled = true;
      };
    }

    const theme = getMermaidTheme();
    const cached = getRememberedMermaidRender(mermaidCacheKey(renderCode, theme));
    if (cached) {
      setRenderState(displayStateFromMermaidEntry(cached, id));
      return () => {
        cancelled = true;
      };
    }

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      const entry = await renderMermaidWithCache(renderCode, theme);
      if (cancelled) return;
      setRenderState(displayStateFromMermaidEntry(entry, id));
    }, 0);
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [renderCode, streaming, id]);

  if (streaming || (!svg && !error)) {
    return (
      <pre className="bg-gray-900 text-gray-100 rounded-lg p-3 my-2 text-xs font-mono overflow-x-auto leading-relaxed">
        <code>{code}</code>
      </pre>
    );
  }

  if (error) {
    return (
      <div className="my-2">
        <pre className="bg-gray-900 text-gray-100 rounded-lg p-3 text-xs font-mono overflow-x-auto leading-relaxed">
          <code>{code}</code>
        </pre>
        <p className="text-xs text-red-500 mt-1">Mermaid 渲染错误: {error}</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="my-2 overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: svg! }}
    />
  );
});

// ── MessageMarkdown ───────────────────────────────────────────────────────────

interface MessageMarkdownProps {
  text: string;
  streaming?: boolean;
  onImageClick?: (src: string) => void;
  onFileClick?: (url: string, filename: string) => void;
}

export const MessageMarkdown = memo(function MessageMarkdown({
  text,
  streaming,
  onImageClick,
  onFileClick,
}: MessageMarkdownProps) {
  const processedText = useMemo(() => preprocessMentions(text), [text]);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code({ node: _node, className, children, ...props }: any) {
          const inline = !className && typeof children === "string" && !/\n/.test(String(children));
          const match = /language-(\w+)/.exec(className || "");
          const lang = match?.[1] ?? "";
          const codeText = String(children).replace(/\n$/, "");

          if (!inline && lang === "mermaid") {
            return <MermaidBlock code={codeText} streaming={streaming} />;
          }

          if (!inline) {
            const highlighted = highlightCode(codeText, lang);
            return (
              <pre className="bg-gray-900 rounded-lg p-3 my-2 text-xs font-mono overflow-x-auto leading-relaxed">
                <code
                  className={`hljs${lang ? ` language-${lang}` : ""}`}
                  dangerouslySetInnerHTML={{ __html: highlighted }}
                />
              </pre>
            );
          }

          return (
            <code className="bg-gray-100 px-1 rounded text-xs font-mono" {...props}>
              {children}
            </code>
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        img({ src, alt, ...props }: any) {
          return (
            <MarkdownImage
              src={src}
              alt={alt}
              onImageClick={onImageClick}
              {...props}
            />
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        a({ href, children, ...props }: any) {
          const raw = href ?? "";

          // @mention chip
          if (raw.startsWith("mention://")) {
            const username = raw.slice("mention://".length);
            return (
              <span className="inline-block bg-blue-100 text-blue-700 text-xs font-semibold px-1.5 py-0.5 rounded cursor-default">
                @{username}
              </span>
            );
          }

          const fileMatch = FILE_URL_RE.exec(raw);
          if (fileMatch) {
            const fileId = fileMatch[1];
            const filename = childrenToText(children);
            return (
              <FileChip
                href={raw}
                fileId={fileId}
                filename={filename}
                onImageClick={onImageClick}
                onFileClick={onFileClick}
              />
            );
          }
          const safe = raw.startsWith("/") || raw.startsWith("http://") || raw.startsWith("https://");
          return (
            <a
              href={safe ? raw : "#"}
              target="_blank"
              rel="noreferrer"
              className="text-[#1264A3] underline"
              {...props}
            >
              {children}
            </a>
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        p({ children, ...props }: any) {
          return (
            <p className="text-sm text-gray-800 leading-relaxed my-0.5" {...props}>
              {children}
            </p>
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        h1({ children, ...props }: any) {
          return <h1 className="text-lg font-bold mt-4 mb-1 text-gray-900 border-b border-gray-200 pb-1" {...props}>{children}</h1>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        h2({ children, ...props }: any) {
          return <h2 className="text-base font-bold mt-3 mb-1 text-gray-900 border-b border-gray-200 pb-1" {...props}>{children}</h2>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        h3({ children, ...props }: any) {
          return <h3 className="text-sm font-semibold mt-2 mb-0.5 text-gray-900" {...props}>{children}</h3>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        h4({ children, ...props }: any) {
          return <h4 className="text-sm font-semibold text-gray-900" {...props}>{children}</h4>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        h5({ children, ...props }: any) {
          return <h5 className="text-xs font-semibold text-gray-900" {...props}>{children}</h5>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        h6({ children, ...props }: any) {
          return <h6 className="text-xs font-semibold text-gray-900" {...props}>{children}</h6>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ul({ children, ...props }: any) {
          return <ul className="list-disc pl-5 my-1 space-y-0.5 text-sm text-gray-800" {...props}>{children}</ul>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ol({ children, ...props }: any) {
          return <ol className="list-decimal pl-5 my-1 space-y-0.5 text-sm text-gray-800" {...props}>{children}</ol>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        blockquote({ children, ...props }: any) {
          return (
            <blockquote
              className="border-l-4 border-blue-300 bg-blue-50 pl-3 py-0.5 my-1 text-gray-600 text-sm italic"
              {...props}
            >
              {children}
            </blockquote>
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        table({ children, ...props }: any) {
          return (
            <div className="overflow-x-auto my-2">
              <table className="border-collapse text-sm text-gray-800 w-full" {...props}>
                {children}
              </table>
            </div>
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        th({ children, ...props }: any) {
          return (
            <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-left font-semibold text-xs" {...props}>
              {children}
            </th>
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        td({ children, ...props }: any) {
          return (
            <td className="border border-gray-200 px-2 py-1 text-xs" {...props}>
              {children}
            </td>
          );
        },
        hr() {
          return <hr className="my-3 border-gray-200" />;
        },
      }}
    >
      {processedText}
    </ReactMarkdown>
  );
});
