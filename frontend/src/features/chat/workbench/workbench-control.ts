import type { ControlSize } from "@/components/ui/control-size";

/** Workbench density tokens by information role. */
export const workbenchControlSize = {
  chrome: "compact",
  toolbar: "regular",
  navigation: "comfortable",
  tab: "regular",
  data: "compact",
  rowAction: "compact",
} as const satisfies Record<string, ControlSize>;
