import { useState } from "react";
import { ChatAttachments } from "../../../components/ChatMessageRenderer";
import { API } from "../../../lib/app-config";
import type { FileInfo, Message } from "../../../types";

export function useFilePreviewController({
  onForwardFile,
}: {
  onForwardFile?: (file: FileInfo) => void;
} = {}) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxFileId, setLightboxFileId] = useState<string | null>(null);
  const [filePreviewPanel, setFilePreviewPanel] = useState<{
    url: string;
    filename: string;
    contentType?: string | null;
    sizeBytes?: number | null;
  } | null>(null);

  const filePreviewUrl = (fileId: string) => `${API}/files/${fileId}/preview`;
  const fileDownloadUrl = (fileId: string) => `${API}/files/${fileId}/download`;

  const openFilePreview = (file: FileInfo) => {
    setFilePreviewPanel({
      url: filePreviewUrl(file.file_id),
      filename: file.original_filename || file.file_id,
      contentType: file.content_type,
      sizeBytes: file.size_bytes,
    });
  };

  const openFilePreviewUrl = (
    url: string,
    filename: string,
    contentType?: string | null,
    sizeBytes?: number | null,
  ) => {
    setFilePreviewPanel({ url, filename, contentType, sizeBytes });
  };

  const handleMarkdownImageClick = (src: string) => {
    const match = src.match(/\/files\/([^/?]+)\/preview/);
    if (match) {
      const fileId = decodeURIComponent(match[1]);
      openFilePreviewUrl(src, `file-${fileId.slice(0, 8)}`, "image/*");
      return;
    }
    setLightboxSrc(src);
    setLightboxFileId(null);
  };

  const handleMarkdownFileClick = (url: string, name: string) => {
    openFilePreviewUrl(url, name);
  };

  const renderFileAttachments = (message: Message, alignRight = false) => (
    <ChatAttachments
      align={alignRight ? "right" : "left"}
      files={message.files}
      getPreviewUrl={(file) => filePreviewUrl(file.file_id)}
      getDownloadUrl={(file) => fileDownloadUrl(file.file_id)}
      onPreview={openFilePreview}
      onForward={onForwardFile}
    />
  );

  return {
    lightboxSrc,
    lightboxFileId,
    setLightboxSrc,
    setLightboxFileId,
    filePreviewPanel,
    setFilePreviewPanel,
    openFilePreview,
    handleMarkdownImageClick,
    handleMarkdownFileClick,
    renderFileAttachments,
  };
}
