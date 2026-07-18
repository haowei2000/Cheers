import { useEffect, useState } from "react";
import {
  Braces,
  Code,
  Code2,
  ExternalLink,
  FileCode2,
  FolderOpen,
  MousePointer2,
} from "lucide-react";
import toast from "react-hot-toast";
import { invokeDesktop } from "@/lib/desktop";
import { getServerBase, isTauri } from "@/lib/serverConfig";

interface Opener {
  key: string;
  label: string;
}

// The opener list is fixed for the session. Locality is decided per file at
// click time (a connector may start/stop mid-session, and a browse root can
// contain both local and non-local subtrees), so it is deliberately NOT cached.
let openersCache: Opener[] | null = null;

/** Brand-ish glyph for each opener key (from connector.rs KNOWN_EDITORS), so the
 *  header shows each install as its own recognizable icon instead of a text menu.
 *  lucide has no editor brand marks, so these are distinct-but-approximate icons
 *  in each app's accent colour; unknown keys fall back to a generic "open". */
function OpenerGlyph({ k }: { k: string }) {
  const c = "w-3.5 h-3.5";
  switch (k) {
    case "finder":
      return <FolderOpen className={`${c} text-sky-400`} />;
    case "vscode":
      return <Code2 className={`${c} text-[#3aa0f0]`} />;
    case "cursor":
      return <MousePointer2 className={`${c} text-zinc-200`} />;
    case "zed":
      return <Code className={`${c} text-indigo-400`} />;
    case "webstorm":
      return <Braces className={`${c} text-cyan-400`} />;
    case "pycharm":
      return <Braces className={`${c} text-emerald-400`} />;
    case "rustrover":
      return <Braces className={`${c} text-orange-400`} />;
    case "sublime":
      return <FileCode2 className={`${c} text-amber-400`} />;
    default:
      return <ExternalLink className={`${c} text-zinc-400`} />;
  }
}

async function probeLocal(absPath: string): Promise<boolean> {
  try {
    return await invokeDesktop<boolean>("local_root_available", {
      root: absPath,
      server: getServerBase(),
    });
  } catch {
    return false;
  }
}

/**
 * "Open in editor" for a remote-workspace file — the M2 same-machine seam at
 * its natural home. Desktop shell only (a browser can't launch local editors).
 * Renders one compact icon button per available opener (Finder + installed
 * editors); the behavior branches at click:
 *   - the file's connector runs on THIS machine → open the real file in place;
 *   - otherwise → download the bytes to a local cache copy and open that
 *     (a detached copy; edits don't sync back).
 * `absPath` is the file's absolute path on the connector box (joinAbs(root,
 * rel)); `getBytesB64` yields the file's bytes for the download path.
 */
export function LocalOpen({
  absPath,
  filename,
  getBytesB64,
}: {
  absPath: string;
  filename: string;
  getBytesB64: () => string | null;
}) {
  const [openers, setOpeners] = useState<Opener[]>(openersCache ?? []);
  // Tooltip hint only; the real decision is re-probed at click so a
  // connector that started/stopped mid-session is reflected.
  const [hintLocal, setHintLocal] = useState<boolean | null>(null);

  // Openers (Finder + installed editors), once per session. Fall back to
  // Finder if the probe fails, so there is always at least one action.
  useEffect(() => {
    if (!isTauri()) return;
    if (openersCache) {
      setOpeners(openersCache);
      return;
    }
    void invokeDesktop<Opener[]>("available_openers")
      .then((list) => {
        openersCache = list.length ? list : [{ key: "finder", label: "Finder" }];
        setOpeners(openersCache);
      })
      .catch(() => setOpeners([{ key: "finder", label: "Finder" }]));
  }, []);

  // Probe this file's locality for the tooltip hint (advisory only).
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void probeLocal(absPath).then((ok) => {
      if (alive) setHintLocal(ok);
    });
    return () => {
      alive = false;
    };
  }, [absPath]);

  // Editors are a desktop capability — a plain browser can't open them.
  if (!isTauri()) return null;

  async function open(opener: string) {
    try {
      // Decide local vs download FRESH at click (never trust a possibly-stale
      // or not-yet-resolved hint): open the real file only if it's genuinely
      // under a local connector root right now.
      const local = await probeLocal(absPath);
      if (local) {
        await invokeDesktop("open_local_path", { path: absPath, opener });
      } else {
        const b64 = getBytesB64();
        if (!b64) {
          toast.error("File content isn't loaded yet — open the file first");
          return;
        }
        await invokeDesktop("open_remote_file", { filename, contentB64: b64, opener });
      }
    } catch (e) {
      toast.error(typeof e === "string" ? e : "couldn't open the file");
    }
  }

  const suffix =
    hintLocal === false ? " (downloaded copy)" : hintLocal ? " (on this machine)" : "";

  return (
    <>
      {openers.map((op) => (
        <button
          key={op.key}
          onClick={() => void open(op.key)}
          title={`Open in ${op.label}${suffix}`}
          className="shrink-0 w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-800"
        >
          <OpenerGlyph k={op.key} />
        </button>
      ))}
    </>
  );
}
