import { getWorkspaceFile, getWorkspaceTree } from "@/api/workspace";

// Tolerant workspace-path resolution for BOT-WRITTEN paths (codemap locators, and any
// future consumer of `cheers:ws/…`). Agents write repo-root-relative paths, but the
// bot's browse root may sit one level ABOVE the repo (root lists `Cheers/…`) or the
// path may redundantly carry the repo dir while the root already IS the repo. Mirrors
// the chat ref-jump philosophy (resolveAndOpenRef): probe layer by layer, only commit
// to a jump the server confirms, and keep every correction BOUNDED — this is a couple
// of targeted probes, not a workspace-wide search.
//
// Returns the path that actually resolves (open the browser THERE), or null when
// nothing does. Non-NOT_FOUND failures (offline connector, authz) propagate — they
// are different failures with different user-facing messages.

function isNotFound(e: unknown): boolean {
  const s = String(e);
  return s.includes("E_NOT_FOUND") || s.includes("No such file");
}

export async function locateWorkspaceFile(
  channelId: string,
  botId: string,
  path: string
): Promise<string | null> {
  const probe = async (p: string): Promise<boolean> => {
    try {
      await getWorkspaceFile(channelId, botId, p);
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  };

  if (await probe(path)) return path;

  // (a) The locator redundantly starts with the repo dir but the root already IS the
  //     repo: "Cheers/server/src/x.rs" → "server/src/x.rs". One extra probe.
  const segs = path.split("/");
  if (segs.length > 1) {
    const stripped = segs.slice(1).join("/");
    if (await probe(stripped)) return stripped;
  }

  // (b) The root is a PARENT of the repo: the file lives under some top-level dir
  //     ("Cheers/server/src/x.rs"). One tree listing, then one probe per top-level
  //     dir, capped — a root with many dirs degrades to "not found", never to a scan.
  try {
    const tree = await getWorkspaceTree(channelId, botId, "");
    const dirs = tree.entries.filter((e) => e.is_dir).slice(0, 12);
    for (const d of dirs) {
      const candidate = `${d.path}/${path}`;
      if (await probe(candidate)) return candidate;
    }
  } catch {
    // tree unavailable (root not listable) — fall through to "not found"
  }
  return null;
}
