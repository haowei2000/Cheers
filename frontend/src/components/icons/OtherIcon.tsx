import { BrandIcon, brandIconMap, type BrandIconProps } from "./BrandIcon";

export const otherIconMap = {
  brand: brandIconMap,
} as const;

export type OtherIconFamily = keyof typeof otherIconMap;

export interface OtherIconProps extends BrandIconProps {
  family?: OtherIconFamily;
}

export function OtherIcon({ family = "brand", ...props }: OtherIconProps) {
  switch (family) {
    case "brand":
    default:
      return <BrandIcon {...props} />;
  }
}
