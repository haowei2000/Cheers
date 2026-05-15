import { FileIcon, defaultStyles } from "react-file-icon";

type FileIconKind =
  | "3d"
  | "acrobat"
  | "android"
  | "audio"
  | "binary"
  | "code"
  | "compressed"
  | "document"
  | "drive"
  | "font"
  | "image"
  | "presentation"
  | "settings"
  | "spreadsheet"
  | "vector"
  | "video";

const imageExtensions = new Set(["bmp", "gif", "jpeg", "jpg", "png", "svg", "tiff", "webp"]);
const spreadsheetExtensions = new Set(["csv", "ods", "xls", "xlsx"]);
const documentExtensions = new Set(["doc", "docx", "md", "rtf", "txt"]);
const presentationExtensions = new Set(["key", "odp", "ppt", "pptx"]);
const compressedExtensions = new Set(["7z", "gz", "rar", "tar", "tgz", "zip"]);
const codeExtensions = new Set([
  "css",
  "go",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "py",
  "rs",
  "sh",
  "sql",
  "ts",
  "tsx",
  "xml",
  "yaml",
  "yml",
]);

function extensionFromName(filename?: string | null): string {
  if (!filename) return "";
  const lastSegment = filename.split(/[\\/]/).pop() ?? "";
  const dotIndex = lastSegment.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) return "";
  return lastSegment.slice(dotIndex + 1).toLowerCase();
}

function resolveType(extension: string, contentType?: string | null): FileIconKind {
  const mime = contentType ?? "";

  if (mime.includes("pdf") || extension === "pdf") return "acrobat";
  if (mime.startsWith("image/") || imageExtensions.has(extension)) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.includes("spreadsheet") || spreadsheetExtensions.has(extension)) return "spreadsheet";
  if (mime.includes("presentation") || presentationExtensions.has(extension)) return "presentation";
  if (mime.includes("zip") || compressedExtensions.has(extension)) return "compressed";
  if (mime.includes("json") || mime.includes("javascript") || codeExtensions.has(extension)) return "code";
  if (mime.includes("word") || mime.startsWith("text/") || documentExtensions.has(extension)) return "document";
  return "document";
}

export interface FileTypeIconProps {
  className?: string;
  contentType?: string | null;
  extension?: string | null;
  filename?: string | null;
  size?: number;
  title?: string;
}

export function FileTypeIcon({
  className,
  contentType,
  extension,
  filename,
  size = 32,
  title,
}: FileTypeIconProps) {
  const resolvedExtension = (extension ?? extensionFromName(filename)).toLowerCase();
  const type = resolveType(resolvedExtension, contentType);
  const defaultStyle = resolvedExtension ? defaultStyles[resolvedExtension] : undefined;

  return (
    <span
      aria-label={title ?? (resolvedExtension.toUpperCase() || "File")}
      className={`inline-flex shrink-0 items-center justify-center ${className ?? ""}`}
      role="img"
      style={{ height: size, width: size }}
    >
      <FileIcon extension={resolvedExtension || undefined} type={type} {...defaultStyle} />
    </span>
  );
}
