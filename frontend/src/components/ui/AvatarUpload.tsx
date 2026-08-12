import { useRef, useState } from "react";
import { Camera, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { Avatar } from "./avatar";
import { contentIconClasses, type ContentSize } from "./content-size";
import { controlSquareClasses } from "./control-size";
import { cn } from "@/lib/cn";

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * An Avatar with a click-to-upload affordance: hover shows a camera overlay,
 * clicking opens a file picker, and the picked image is shown optimistically
 * (object URL) while `onUpload` runs. `onUpload` returns the new avatar_url so
 * the caller can persist it (store / refetch).
 */
export function AvatarUpload({
  name,
  id,
  src,
  size = "large",
  onUpload,
}: {
  name?: string | null;
  id?: string;
  src?: string | null;
  size?: ContentSize;
  onUpload: (file: File) => Promise<string>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the user re-pick the same file
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please pick an image file");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("Image must be 5 MB or smaller");
      return;
    }
    setBusy(true);
    setPreview(URL.createObjectURL(file));
    try {
      await onUpload(file);
      toast.success("Avatar updated");
    } catch (err) {
      setPreview(null);
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
      disabled={busy}
      data-design-system-exempt="identity"
      className={cn(
        "group relative inline-flex flex-shrink-0 items-center justify-center rounded-full",
        controlSquareClasses.comfortable,
      )}
      title="Change avatar"
    >
      <Avatar name={name} id={id} src={preview || src || undefined} size={size} />
      <span data-design-system-exempt="identity" className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
        {busy ? (
          <Loader2 className={`${contentIconClasses.regular} animate-spin text-white`} />
        ) : (
          <Camera className={`${contentIconClasses.regular} text-white`} />
        )}
      </span>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={onPick}
      />
    </button>
  );
}
