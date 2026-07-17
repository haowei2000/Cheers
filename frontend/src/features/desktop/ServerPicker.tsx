import { useState } from "react";
import { Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { normalizeBase, setServerBase } from "@/lib/serverConfig";

/** First-run screen of the desktop shell: pick the Cheers server this app
 * talks to. Stored as a bare origin (serverConfig); every REST/WS/asset URL
 * derives from it. Reachability is checked against GET /health before saving
 * so a typo fails here, not as a broken login page. */
export function ServerPicker() {
  const [value, setValue] = useState("https://www.tocheers.com");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    const base = normalizeBase(value);
    if (!base) {
      setError("Enter a server address, e.g. https://www.tocheers.com");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`health check failed (HTTP ${res.status})`);
      setServerBase(base);
      // Full reload: module-level state (sockets, caches) must all rebind to
      // the new base, and the app boots straight into the normal login flow.
      window.location.reload();
    } catch (e) {
      setError(
        e instanceof Error && e.name === "TimeoutError"
          ? "Server didn't respond — check the address and your network."
          : `Couldn't reach that server${e instanceof Error ? ` (${e.message})` : ""}.`
      );
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-zinc-900 rounded-2xl p-6">
        <p className="text-sm font-medium text-zinc-200 flex items-center gap-2">
          <Server className="w-4 h-4 text-indigo-400" /> Connect to a Cheers server
        </p>
        <p className="text-xs text-zinc-400 mt-1 mb-4">
          The address of the Cheers deployment this app should talk to. You can
          change it later in Settings → Account.
        </p>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && void connect()}
          placeholder="https://www.tocheers.com"
          autoFocus
        />
        {error && <p className="text-xs text-rose-400 mt-2">{error}</p>}
        <div className="mt-4">
          <Button onClick={() => void connect()} disabled={busy}>
            {busy ? "Checking…" : "Connect"}
          </Button>
        </div>
      </div>
    </div>
  );
}
