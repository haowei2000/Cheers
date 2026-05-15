import { aiBrandIconMap } from "./AiBrandIcon";
import { appIconMap } from "./AppIcon";
import { brandIconMap } from "./BrandIcon";

export const iconMap = {
  aiBrand: aiBrandIconMap,
  brand: brandIconMap,
  main: appIconMap,
} as const;

export const iconLibraryGuide = {
  aiBrand: "@lobehub/icons",
  brand: "simple-icons",
  fileType: "react-file-icon",
  main: "lucide-react",
} as const;

export type IconCategory = keyof typeof iconMap | "fileType";
