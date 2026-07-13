import { FileIcon, FolderIcon } from "react-material-icon-theme";

// Material Icon Theme file/folder glyph, resolved by name (VS Code's icon set, best-in-class
// file-type differentiation). The upstream library is a ~279 kB-gzip monolith with NO
// code-splitting and no tree-shaking (its resolver references the full icon map), so this
// wrapper exists to be a single React.lazy boundary: the whole icon set downloads as its own
// chunk only when a file tree that uses it first renders — never on the chat critical path.
export default function MaterialFsIcon({
  isDir,
  name,
  size = 16,
}: {
  isDir: boolean;
  name: string;
  size?: number;
}) {
  return isDir ? (
    <FolderIcon folderName={name} size={size} />
  ) : (
    <FileIcon fileName={name} size={size} />
  );
}
