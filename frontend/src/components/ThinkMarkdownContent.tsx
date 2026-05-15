import { memo, useMemo } from "react";
import { renderWithThinkFolding } from "../lib/think";

export interface ThinkMarkdownContentProps {
  content: string;
  keyPrefix?: string;
  onFileClick?: (url: string, filename: string) => void;
  onImageClick?: (src: string) => void;
  streaming?: boolean;
}

export const ThinkMarkdownContent = memo(function ThinkMarkdownContent({
  content,
  keyPrefix,
  onFileClick,
  onImageClick,
  streaming,
}: ThinkMarkdownContentProps) {
  const rendered = useMemo(
    () =>
      renderWithThinkFolding(
        content,
        keyPrefix,
        streaming,
        onImageClick,
        onFileClick,
      ),
    [content, keyPrefix, onFileClick, onImageClick, streaming],
  );

  return <>{rendered}</>;
});
