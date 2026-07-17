import { useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
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
 * Always shown; the behavior branches at click:
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
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Openers (Finder + installed editors), once per session. Fall back to
  // Finder if the probe fails, so the button is never a dead end.
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

  // Probe this file's locality for the tooltip/menu hint (advisory only).
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

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  // Editors are a desktop capability — a plain browser can't open them.
  if (!isTauri()) return null;

  async function open(opener: string) {
    setMenuOpen(false);
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
        await invokeDesktop("open_remote_file", {
          filename,
          contentB64: b64,
          opener,
        });
      }
    } catch (e) {
      toast.error(typeof e === "string" ? e : "couldn't open the file");
    }
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setMenuOpen((o) => !o)}
        title={
          hintLocal
            ? "Open the real file on your machine (its connector runs here)"
            : "Download a local copy and open it (edits won't sync back)"
        }
        className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-zinc-800 text-zinc-300"
      >
        <FolderOpen className="w-3 h-3" /> Open in editor
      </button>
      {menuOpen && openers.length > 0 && (
        <div className="absolute right-0 top-full mt-1 z-20 rounded-lg bg-zinc-900 shadow-xl shadow-black/40 py-1 min-w-[9rem]">
          {hintLocal === false && (
            <p className="px-3 py-1 text-[10px] text-zinc-500 border-b border-zinc-800">
              Remote file — opens a downloaded copy
            </p>
          )}
          {openers.map((op) => (
            <button
              key={op.key}
              onClick={() => void open(op.key)}
              className="block w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
            >
              {op.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
