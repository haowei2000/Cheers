/**
 * ContentSize scales identity and semantic content independently from the
 * physical ControlSize hit target. Do not add a fourth tier.
 */
export type ContentSize = "small" | "regular" | "large";

export const avatarSizeClasses: Record<ContentSize, string> = {
  small: "h-5 w-5 text-minimal",
  regular: "h-7 w-7 text-compact",
  large: "h-9 w-9 text-regular",
};

export const contentIconClasses: Record<ContentSize, string> = {
  small: "h-3.5 w-3.5",
  regular: "h-4 w-4",
  large: "h-5 w-5",
};

export const presenceSizeClasses: Record<ContentSize, string> = {
  small: "h-1.5 w-1.5 ring-1",
  regular: "h-2 w-2 ring-2",
  large: "h-2.5 w-2.5 ring-2",
};

/** Metadata rail paired with Avatar at the same ContentSize. */
export const identityRailWidthClasses: Record<ContentSize, string> = {
  small: "w-16",
  regular: "w-24",
  large: "w-32",
};

export const dragHandleClasses = "h-1 w-8 rounded-full";
