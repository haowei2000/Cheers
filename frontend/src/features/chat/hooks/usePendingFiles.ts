import { useCallback, useMemo, useState } from "react";
import toast from "react-hot-toast";
import type { ChangeEvent } from "react";
import type { AuthFetch } from "../../../api/client";
import { API } from "../../../lib/app-config";

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
  const [pendingFileIds, setPendingFileIds] = useState<string[]>([]);
  const [pendingFileNames, setPendingFileNames] = useState<string[]>([]);
  const [pendingFilePreviews, setPendingFilePreviews] = useState<
    (string | null)[]
  >([]);

  const pendingFiles = useMemo(
    () =>
      pendingFileNames.map((name, index) => ({
        name,
        previewUrl: pendingFilePreviews[index] ?? null,
      })),
    [pendingFileNames, pendingFilePreviews],
  );

  const appendPendingFile = useCallback(
    (fileId: string, filename: string, previewUrl: string | null) => {
      setPendingFileIds((prev) => [...prev, fileId]);
      setPendingFileNames((prev) => [...prev, filename]);
      setPendingFilePreviews((prev) => [...prev, previewUrl]);
    },
    [],
  );

  const removePendingFile = useCallback((index: number) => {
    setPendingFileIds((prev) =>
      prev.filter((_, itemIndex) => itemIndex !== index),
    );
    setPendingFileNames((prev) =>
      prev.filter((_, itemIndex) => itemIndex !== index),
    );
    setPendingFilePreviews((prev) => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed);
      return prev.filter((_, itemIndex) => itemIndex !== index);
    });
  }, []);

  const clearPendingFiles = useCallback(() => {
    setPendingFileIds([]);
    setPendingFileNames([]);
    setPendingFilePreviews((prev) => {
      prev.forEach((url) => {
        if (url) URL.revokeObjectURL(url);
      });
      return [];
    });
  }, []);

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
        appendPendingFile(file_id, file.name, localPreview);
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
    pendingFileNames,
    pendingFilePreviews,
    pendingFiles,
    removePendingFile,
    clearPendingFiles,
    uploadFileObject,
    uploadFileObjects,
    uploadFile,
  };
}
