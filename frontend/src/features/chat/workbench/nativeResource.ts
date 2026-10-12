import { getWorkspaceFile } from "@/api/workspace";
import { openDesktopFile } from "@/lib/desktopResource";
import { parseLocator } from "../locator";
import type { FsClient } from "./fsClient";
import { isTauri } from "@/lib/serverConfig";
import { createInteractionDispatcher } from "./interaction";

/** All resource containers use the same host capabilities and executor adapters. */
export function createResourceInteractionDispatcher(host: Parameters<typeof createInteractionDispatcher>[0] & { channelId: string; fs: FsClient }) {
  return createInteractionDispatcher({ ...host, openNative: isTauri() ? createNativeResourceOpener(host.channelId, host.fs) : undefined });
}

export function createNativeResourceOpener(channelId: string, fs: FsClient) {
  return async (uri: string, opener: string): Promise<"local" | "downloaded-copy"> => {
    const target = parseLocator(uri);
    if (target?.kind === "desk") {
      const file = await fs.read(target.path);
      if (file.is_dir) throw new Error("Select a file to open in a local application.");
      const bytes = new TextEncoder().encode(file.content);
      let binary = "";
      for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
      return openDesktopFile({ filename: target.path.split("/").pop()!, getBytesB64: () => btoa(binary), opener });
    }
    if (target?.kind === "ws" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.bot)) {
      // The gateway checks workspace grants and resolves the root. The native
      // shell rechecks canonical local roots before opening the original file.
      const file = await getWorkspaceFile(channelId, target.bot, target.path);
      return openDesktopFile({ absPath: `${file.root.replace(/\/$/, "")}/${file.path}`, filename: file.filename, getBytesB64: () => file.content_b64, opener });
    }
    throw new Error("Native opening supports Desk files and workspace files with stable bot ids.");
  };
}
