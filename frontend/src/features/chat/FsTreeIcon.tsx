import { FileIcon, defaultStyles, type DefaultExtensionType } from "react-file-icon";
import { Folder } from "lucide-react";

// File/folder icon for the Remote Workspace tree. Files get react-file-icon's colored,
// per-extension glyphs (Seti palette — same set already used for chat attachments), which
// makes types easy to tell apart; folders keep the lucide folder glyph. react-file-icon is
// small and React-18-safe, so no lazy boundary is needed.
//
// (This replaced react-material-icon-theme, which bundled a React-19 JSX runtime and crashed
// under this project's React 18 with `recentlyCreatedOwnerStacks` undefined.)
export function FsTreeIcon({
  isDir,
  name,
  size = 16,
}: {
  isDir: boolean;
  name: string;
  size?: number;
}) {
  if (isDir) {
    return <Folder className="text-sky-400 shrink-0" style={{ width: size, height: size }} />;
  }
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const style = defaultStyles[ext as DefaultExtensionType] ?? {};
  return (
    <span className="shrink-0 inline-block" style={{ width: size, lineHeight: 0 }}>
      <FileIcon extension={ext || undefined} {...style} />
    </span>
  );
}
