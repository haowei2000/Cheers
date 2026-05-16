import { AppIcon } from "./icons/AppIcon";

interface ImageLightboxProps {
  src: string | null;
  fileId: string | null;
  onClose: () => void;
  onEdit?: (fileId: string) => void;
}

export function ImageLightbox({ src, fileId, onClose, onEdit }: ImageLightboxProps) {
  if (!src) return null;
  return (
    <div
      className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center cursor-zoom-out"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white text-xl transition-colors"
      >
        <AppIcon name="close" className="w-6 h-6" />
      </button>
      {fileId && onEdit && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(fileId);
          }}
          className="absolute top-4 left-4 flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-[13px] font-medium transition-colors"
        >
          <AppIcon name="pencil" className="w-4 h-4" />
          Edit this image
        </button>
      )}
      <img
        src={src}
        alt="preview"
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl cursor-default"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
