import { renderWithThinkFolding } from "../lib/think";

export interface ThinkMarkdownContentProps {
  content: string;
  keyPrefix?: string;
  onFileClick?: (url: string, filename: string) => void;
  onImageClick?: (src: string) => void;
  streaming?: boolean;
}

export function ThinkMarkdownContent({
  content,
  keyPrefix,
  onFileClick,
  onImageClick,
  streaming,
}: ThinkMarkdownContentProps) {
  return (
    <>
      {renderWithThinkFolding(
        content,
        keyPrefix,
        streaming,
        onImageClick,
        onFileClick,
      )}
    </>
  );
}
