/** Host-evaluated file matching rules for personal extension renderers. */
export interface RendererMatch {
  format?: string | string[];
  glob?: string;
  requireAll?: string[];
  requireAny?: string[];
  dataHas?: string[];
  dataKind?: "object" | "array";
  jsonHas?: string[];
}

export interface RendererRuntimeManifest {
  renderers?: Array<{
    id: string;
    title: string;
    entry?: string;
    style?: string;
    match?: string[] | RendererMatch;
  }>;
  automations?: Array<{ id: string; title: string }>;
  permissions?: {
    "file.write"?: boolean;
    "channel.resources"?: string[];
    "navigation.open"?: boolean;
    "composer.prefill"?: boolean;
    "automation.manage"?: boolean;
    network?: "unrestricted";
  };
}

/** A parsed personal or temporary macOS extension ready for sandbox execution. */
export interface RendererExtension {
  extensionId: string;
  title: string;
  manifest: RendererRuntimeManifest;
  origin?: "personal" | "temporary";
  assets?: Record<string, string>;
  transient?: boolean;
}
