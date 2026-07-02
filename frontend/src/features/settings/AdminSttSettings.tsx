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
      setTestResult(r.ok ? "✓ 连接成功（端点可用）" : `✗ ${r.error ?? "测试失败"}`);
    } catch (e) {
      setTestResult(`✗ ${e instanceof Error ? e.message : "测试失败"}`);
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
          语音消息/音频文件会由网关后台发送到这里配置的 OpenAI 兼容转写服务
          （<code className="text-zinc-400">/audio/transcriptions</code>），转写文本随消息展示并投递给
          bot。音频将离开本实例发往该端点 —— 请只配置你信任的服务。
        </p>

        <div className="grid gap-3 max-w-lg">
          <label className="flex items-center gap-2 text-sm text-zinc-200">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 accent-indigo-500"
            />
            启用语音转文字
          </label>

          <div>
            <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide block mb-1">
              Endpoint（含 /v1 的 base URL）
            </label>
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://api.openai.com/v1 或 http://cheers-stt:8000/v1"
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
                  （已保存 {loaded.api_key_hint}，留空保持不变）
                </span>
              )}
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={clearKey}
              placeholder={loaded?.api_key_set ? "输入新 key 以替换" : "sk-…（无鉴权服务可留空）"}
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
                清除已保存的 key
              </label>
            )}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => void save()}
              disabled={busy !== null}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors"
            >
              {busy === "save" ? "保存中…" : "保存"}
            </button>
            <button
              onClick={() => void test()}
              disabled={busy !== null || !loaded?.configured}
              title={loaded?.configured ? "用已保存的配置发送一段测试音频" : "先保存再测试"}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 transition-colors"
            >
              {busy === "test" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FlaskConical className="h-3.5 w-3.5" />
              )}
              测试连接
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
