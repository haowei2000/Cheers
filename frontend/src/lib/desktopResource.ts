import { invokeDesktop } from "./desktop";
import { getServerBase, isTauri } from "./serverConfig";

export async function probeDesktopFile(absPath: string): Promise<boolean> {
  if (!isTauri()) return false;
  try { return await invokeDesktop<boolean>("local_root_available", { root: absPath, server: getServerBase() }); }
  catch { return false; }
}

/** Paths come from authorized resource reads, never model-supplied commands. */
export async function openDesktopFile(options: {
  absPath?: string;
  filename: string;
  getBytesB64: () => string | null;
  opener: string;
}): Promise<"local" | "downloaded-copy"> {
  if (!isTauri()) throw new Error("Opening a file in a local application requires Cheers for Mac.");
  const openers = await invokeDesktop<{ key: string }[]>("available_openers");
  if (!openers.some((entry) => entry.key === options.opener)) throw new Error("The selected application is unavailable on this device.");
  if (options.absPath && await probeDesktopFile(options.absPath)) {
    await invokeDesktop("open_local_path", { path: options.absPath, opener: options.opener });
    return "local";
  }
  const contentB64 = options.getBytesB64();
  if (contentB64 === null) throw new Error("File content is unavailable. Open the resource and try again.");
  await invokeDesktop("open_remote_file", { filename: options.filename, contentB64, opener: options.opener });
  return "downloaded-copy";
}
