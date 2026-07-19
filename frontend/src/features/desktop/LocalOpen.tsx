import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import toast from "react-hot-toast";
import { invokeDesktop } from "@/lib/desktop";
import { getServerBase, isTauri } from "@/lib/serverConfig";
import { OpenerGlyph } from "./openerIcons";

interface Opener {
  key: string;
  label: string;
}

// The opener list is fixed for the session. Locality is decided per file at
// click time (a connector may start/stop mid-session, and a browse root can
// contain both local and non-local subtrees), so it is deliberately NOT cached.
let openersCache: Opener[] | null = null;
// Last opener the user picked, remembered across the session so the split
// button's primary action stays on their preferred app.
let lastOpenerKey: string | null = null;

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
 * One split button: the selected app's icon opens the file directly; the chevron
 * drops down the full opener list (Finder + installed editors) to switch, and
 * the pick is remembered. The behavior branches at click:
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
  const [selectedKey, setSelectedKey] = useState<string | null>(lastOpenerKey);
  // Tooltip hint only; the real decision is re-probed at click so a
  // connector that started/stopped mid-session is reflected.
  const [hintLocal, setHintLocal] = useState<boolean | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

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
    lastOpenerKey = opener;
    setSelectedKey(opener);
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

  // The primary (icon) action targets the remembered opener, else the first.
  const selected = openers.find((o) => o.key === selectedKey) ?? openers[0];
  if (!selected) return null; // openers not loaded yet

  const suffix =
    hintLocal === false ? " (downloaded copy)" : hintLocal ? " (on this machine)" : "";

  return (
    <div className="relative shrink-0" ref={wrapRef}>
      <div className="flex items-center rounded hover:bg-zinc-800">
        <button
          onClick={() => void open(selected.key)}
          title={`Open in ${selected.label}${suffix}`}
          className="h-7 pl-1.5 pr-0.5 flex items-center justify-center rounded-l"
        >
          <OpenerGlyph k={selected.key} />
        </button>
        <button
          onClick={() => setMenuOpen((o) => !o)}
          title="Open in another app"
          aria-label="Choose an app to open in"
          className="h-7 pr-1 pl-0 flex items-center rounded-r text-zinc-400 hover:text-zinc-200"
        >
          <ChevronDown className="w-3 h-3" />
        </button>
      </div>
      {menuOpen && (
        <div className="absolute right-0 top-full mt-1 z-20 rounded-lg bg-zinc-900 shadow-xl shadow-black/40 py-1 min-w-[9.5rem]">
          {hintLocal === false && (
            <p className="px-3 py-1 text-[10px] text-zinc-500 border-b border-zinc-800">
              Remote file — opens a downloaded copy
            </p>
          )}
          {openers.map((op) => (
            <button
              key={op.key}
              onClick={() => void open(op.key)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
            >
              <OpenerGlyph k={op.key} className="w-4 h-4" />
              {op.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
