import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { AudioLines, FlaskConical, Loader2 } from "lucide-react";
import { useIsAdmin } from "@/stores/authStore";
import {
  getSttSettings,
  putSttSettings,
  testSttSettings,
  type SttSettings,
} from "@/api/adminSettings";

// Admin-only: the instance-wide speech-to-text endpoint used by the gateway's
// transcription worker (voice notes / audio uploads → transcript). Runtime
// setting — saving takes effect on the worker's next poll, no restart. Renders
// nothing for non-admins (route-level nav is also admin-gated; defense in depth).
export function AdminSttSettings() {
  const isAdmin = useIsAdmin();
  const [loaded, setLoaded] = useState<SttSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState(""); // empty = keep the stored key
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    getSttSettings()
      .then((s) => {
        setLoaded(s);
        setEnabled(s.enabled);
        setEndpoint(s.endpoint);
        setModel(s.model);
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed to load STT settings"));
  }, [isAdmin]);

  if (!isAdmin) return null;

  async function save() {
    setBusy("save");
    setTestResult(null);
    try {
      const s = await putSttSettings({
        enabled,
        endpoint,
        model,
        // Omit to keep the stored key; "" clears it; non-empty replaces it.
        ...(clearKey ? { api_key: "" } : apiKey ? { api_key: apiKey } : {}),
      });
      setLoaded(s);
      setApiKey("");
      setClearKey(false);
      toast.success("STT settings saved — takes effect within seconds");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    setTestResult(null);
    try {
      const r = await testSttSettings();
      setTestResult(r.ok ? "✓ Connected (endpoint reachable)" : `✗ ${r.error ?? "Test failed"}`);
    } catch (e) {
      setTestResult(`✗ ${e instanceof Error ? e.message : "Test failed"}`);
    } finally {
      setBusy(null);
    }
  }

  const inputCls =
    "w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500/60";

  return (
    <section>
      <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4 flex items-center gap-2">
        <AudioLines className="w-3.5 h-3.5" />
        Speech-to-text
      </h2>

      <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6">
        <p className="text-xs text-zinc-500 mb-4">
          Voice messages and audio files are sent by the gateway to the OpenAI-compatible
          transcription service configured here
          (<code className="text-zinc-400">/audio/transcriptions</code>). Transcripts are shown
          with the message and delivered to bots. Audio leaves this instance for that endpoint —
          only configure a service you trust.
        </p>

        <div className="grid gap-3 max-w-lg">
          <label className="flex items-center gap-2 text-sm text-zinc-200">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 accent-indigo-500"
            />
            Enable speech-to-text
          </label>

          <div>
            <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide block mb-1">
              Endpoint (base URL including /v1)
            </label>
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://api.openai.com/v1 or http://cheers-stt:8000/v1"
              className={inputCls}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide block mb-1">
              Model
            </label>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="whisper-1"
              className={inputCls}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide block mb-1">
              API key{" "}
              {loaded?.api_key_set && !clearKey && (
                <span className="normal-case text-zinc-400">
                  (saved {loaded.api_key_hint} — leave blank to keep it)
                </span>
              )}
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={clearKey}
              placeholder={
                loaded?.api_key_set
                  ? "Enter a new key to replace it"
                  : "sk-… (leave blank if the service needs no auth)"
              }
              autoComplete="off"
              className={`${inputCls} disabled:opacity-40`}
            />
            {loaded?.api_key_set && (
              <label className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
                <input
                  type="checkbox"
                  checked={clearKey}
                  onChange={(e) => setClearKey(e.target.checked)}
                  className="h-3.5 w-3.5 accent-rose-500"
                />
                Clear the saved key
              </label>
            )}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => void save()}
              disabled={busy !== null}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors"
            >
              {busy === "save" ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => void test()}
              disabled={busy !== null || !loaded?.configured}
              title={
                loaded?.configured
                  ? "Send a short test clip using the saved settings"
                  : "Save the settings before testing"
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 transition-colors"
            >
              {busy === "test" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FlaskConical className="h-3.5 w-3.5" />
              )}
              Test connection
            </button>
          </div>

          {testResult && (
            <p
              className={`text-xs ${testResult.startsWith("✓") ? "text-emerald-400" : "text-rose-400"}`}
            >
              {testResult}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
