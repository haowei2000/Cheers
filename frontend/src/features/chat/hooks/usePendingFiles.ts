import { useCallback, useMemo, useState } from "react";
import toast from "react-hot-toast";
import type { ChangeEvent } from "react";
import type { AuthFetch } from "../../../api/client";
import type { ComposerPendingFile } from "../../../components/MessageComposer";
import { API } from "../../../lib/app-config";
import type { FileDragReference } from "../../../lib/file-drag";

const PRESIGN_EXTS = new Set([
  ".txt",
  ".md",
  ".html",
  ".htm",
  ".doc",
  ".docx",
  ".xls",
  ".pdf",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".wps",
  ".et",
  ".dps",
  ".ofd",
  ".rtf",
  ".csv",
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".dwg",
  ".dxf",
  ".epub",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
]);

const CONTENT_TYPE_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ofd": "application/ofd",
  ".rtf": "application/rtf",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".bz2": "application/x-bzip2",
  ".xz": "application/x-xz",
  ".dxf": "image/vnd.dxf",
  ".epub": "application/epub+zip",
};

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

interface UsePendingFilesOptions {
  selectedId: string | null;
  currentUserId: string;
  authFetch: AuthFetch;
  onRequireLogin: () => void;
}

export function usePendingFiles({
  selectedId,
  currentUserId,
  authFetch,
  onRequireLogin,
}: UsePendingFilesOptions) {
  const [pendingAttachments, setPendingAttachments] = useState<
    ComposerPendingFile[]
  >([]);

  const pendingFileIds = useMemo(
    () => pendingAttachments.map((file) => file.fileId),
    [pendingAttachments],
  );
  const pendingFiles = pendingAttachments;

  const appendPendingFile = useCallback((file: ComposerPendingFile) => {
    setPendingAttachments((prev) =>
      prev.some((item) => item.fileId === file.fileId) ? prev : [...prev, file],
    );
  }, []);

  const removePendingFile = useCallback((index: number) => {
    setPendingAttachments((prev) => {
      const removed = prev[index];
      if (removed?.previewUrl && removed.source === "upload") {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return prev.filter((_, itemIndex) => itemIndex !== index);
    });
  }, []);

  const clearPendingFiles = useCallback(() => {
    setPendingAttachments((prev) => {
      prev.forEach((file) => {
        if (file.previewUrl && file.source === "upload") {
          URL.revokeObjectURL(file.previewUrl);
        }
      });
      return [];
    });
  }, []);

  const attachExistingFiles = useCallback(
    (files: FileDragReference[]) => {
      const pendingIds = new Set(pendingAttachments.map((file) => file.fileId));
      const nextIds = new Set(pendingIds);
      const attachments: ComposerPendingFile[] = [];
      for (const file of files) {
        const fileId = file.file_id;
        if (!fileId || nextIds.has(fileId)) continue;
        nextIds.add(fileId);
        attachments.push({
          fileId,
          name: file.original_filename || fileId,
          previewUrl: null,
          contentType: file.content_type,
          sizeBytes: file.size_bytes,
          source: "existing",
        });
      }
      if (attachments.length === 0) {
        if (files.some((file) => file.file_id && pendingIds.has(file.file_id))) {
          toast("File already attached");
        }
        return;
      }

      setPendingAttachments((prev) => {
        const seen = new Set(prev.map((file) => file.fileId));
        const deduped = attachments.filter((file) => {
          if (seen.has(file.fileId)) return false;
          seen.add(file.fileId);
          return true;
        });
        return deduped.length > 0 ? [...prev, ...deduped] : prev;
      });

      toast.success(
        attachments.length === 1
          ? "File attached to composer"
          : `${attachments.length} files attached to composer`,
      );
    },
    [pendingAttachments],
  );

  const attachExistingFile = useCallback(
    (file: FileDragReference) => attachExistingFiles([file]),
    [attachExistingFiles],
  );

  const uploadFileObject = useCallback(
    async (file: File) => {
      if (!selectedId) return;
      if (!currentUserId) {
        onRequireLogin();
        toast.error("Sign in before uploading files");
        return;
      }
      const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
      if (!PRESIGN_EXTS.has(ext)) {
        toast.error(`Unsupported format: ${ext}`);
        return;
      }
      const localPreview = IMAGE_EXTS.has(ext)
        ? URL.createObjectURL(file)
        : null;
      const contentType =
        file.type || CONTENT_TYPE_MAP[ext] || "application/octet-stream";
      try {
        const presignRes = await authFetch(`${API}/files/presign`, {
          method: "POST",
          body: JSON.stringify({
            channel_id: selectedId,
            uploader_id: currentUserId,
            filename: file.name,
            content_type: contentType,
            size_bytes: file.size,
          }),
        });
        const presignData = await presignRes.json();
        if (!presignRes.ok || !presignData.data?.upload_url) {
          toast.error(presignData.detail || "Failed to get upload credentials");
          if (localPreview) URL.revokeObjectURL(localPreview);
          return;
        }
        const {
          file_id,
          upload_url,
          headers: uploadHeaders,
        } = presignData.data;
        const putRes = await fetch(upload_url, {
          method: "PUT",
          headers: uploadHeaders,
          body: file,
        });
        if (!putRes.ok) {
          toast.error("File upload failed. Try again.");
          if (localPreview) URL.revokeObjectURL(localPreview);
          return;
        }
        const confirmRes = await authFetch(`${API}/files/${file_id}/confirm`, {
          method: "POST",
        });
        if (!confirmRes.ok) {
          console.warn("confirm upload failed", await confirmRes.text());
          toast.error("File upload could not be confirmed. Try again.");
          if (localPreview) URL.revokeObjectURL(localPreview);
          return;
        }
        appendPendingFile({
          fileId: file_id,
          name: file.name,
          previewUrl: localPreview,
          contentType,
          sizeBytes: file.size,
          source: "upload",
        });
      } catch (err) {
        toast.error("File upload failed");
        if (localPreview) URL.revokeObjectURL(localPreview);
        console.error(err);
      }
    },
    [appendPendingFile, authFetch, currentUserId, onRequireLogin, selectedId],
  );

  const uploadFileObjects = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        await uploadFileObject(file);
      }
    },
    [uploadFileObject],
  );

  const uploadFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (files.length === 0) return;
      await uploadFileObjects(files);
    },
    [uploadFileObjects],
  );

  return {
    pendingFileIds,
    pendingFiles,
    removePendingFile,
    clearPendingFiles,
    attachExistingFile,
    attachExistingFiles,
    uploadFileObject,
    uploadFileObjects,
    uploadFile,
  };
}
