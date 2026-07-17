import { getWorkspaceFile, getWorkspaceTree } from "@/api/workspace";

// Tolerant workspace-path resolution for BOT-WRITTEN paths (codemap locators, and any
// future consumer of `cheers:ws/…`). Two classes of uncertainty, both observed in the
// field:
//
//  - ROOT BASIS: agents write repo-root-relative paths, but the bot's browse root may
//    sit one level above the repo, or the path may redundantly carry the repo dir.
//  - FILE vs DIRECTORY: a module's natural loc is often a folder ("server/src/gateway").
//    The file endpoint reports directories as E_IS_DIR — or, on some connectors, as
//    not-found — so a candidate is only ruled out after a cheap tree listing confirms
//    it is not a directory either.
//
// Mirrors the chat ref-jump philosophy (resolveAndOpenRef): probe layer by layer, only
// commit to a jump the server confirms, and keep every correction BOUNDED — a handful
// of targeted probes, never a workspace-wide search. Returns what actually resolved
// (and whether it is a file or a directory — directories open the folder view), or
// null when nothing does. Failures other than not-found (offline connector, authz)
// propagate — they are different failures with different user-facing messages.

export interface LocatedWorkspacePath {
  path: string;
  kind: "file" | "dir";
}

function isNotFound(e: unknown): boolean {
  const s = String(e);
  return s.includes("E_NOT_FOUND") || s.includes("No such file") || s.includes("404");
}
function isDirError(e: unknown): boolean {
  return String(e).includes("E_IS_DIR");
}

export async function locateWorkspaceFile(
  channelId: string,
  botId: string,
  path: string
): Promise<LocatedWorkspacePath | null> {
  const probe = async (p: string): Promise<"file" | "dir" | null> => {
    try {
      await getWorkspaceFile(channelId, botId, p);
      return "file";
    } catch (e) {
      if (isDirError(e)) return "dir";
      if (!isNotFound(e)) throw e;
    }
    // The file endpoint said not-found — but some connectors say that for directories
    // too. Confirm with a listing before ruling the candidate out.
    try {
      await getWorkspaceTree(channelId, botId, p);
      return "dir";
    } catch {
      return null; // tree can't see it either — a real miss for this candidate
    }
  };

  const hit = async (p: string): Promise<LocatedWorkspacePath | null> => {
    const kind = await probe(p);
    return kind ? { path: p, kind } : null;
  };

  const exact = await hit(path);
  if (exact) return exact;

  // (a) The locator redundantly starts with the repo dir but the root already IS the
  //     repo: "Cheers/server/src/x.rs" → "server/src/x.rs".
  const segs = path.split("/");
  if (segs.length > 1) {
    const stripped = await hit(segs.slice(1).join("/"));
    if (stripped) return stripped;
  }

  // (b) The root is a PARENT of the repo: the target lives under some top-level dir
  //     ("Cheers/server/src/x.rs"). One root listing, then one probe per top-level
  //     dir, capped — a root with many dirs degrades to "not found", never to a scan.
  try {
    const tree = await getWorkspaceTree(channelId, botId, "");
    const dirs = tree.entries.filter((e) => e.is_dir).slice(0, 12);
    for (const d of dirs) {
      const prefixed = await hit(`${d.path}/${path}`);
      if (prefixed) return prefixed;
    }
  } catch {
    // root not listable — fall through to "not found"
  }
  return null;
}
