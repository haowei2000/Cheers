import { FileIcon, defaultStyles, type DefaultExtensionType } from "react-file-icon";
import type { FileInfo } from "@/types";
import { extOf } from "./fileUtils";

// Colorful, per-extension file-type icon (react-file-icon). The SVG scales to its
// container width, so we wrap it in a fixed-width box to control the rendered size.
export function FileTypeIcon({
  file,
  size = 28,
  className = "",
}: {
  file: FileInfo;
  size?: number;
  className?: string;
}) {
  const ext = extOf(file);
  const style = defaultStyles[ext as DefaultExtensionType] ?? {};
  return (
    <span
      className={className}
      style={{ display: "inline-block", width: size, lineHeight: 0 }}
    >
      <FileIcon extension={ext || undefined} {...style} />
    </span>
  );
}
