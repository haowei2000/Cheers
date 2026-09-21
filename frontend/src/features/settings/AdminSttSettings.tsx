import { useEffect, useState } from "react";
import { ActionButton } from "@/components/ui/action-button";
import { Banner } from "@/components/ui/banner";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SettingsCard, SettingsSection } from "@/components/ui/settings-card";
import toast from "react-hot-toast";
import { AlertCircle, AudioLines, CircleCheck } from "lucide-react";
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
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

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
      setTestResult({
        ok: r.ok,
        message: r.ok ? "Connected — the saved endpoint is reachable." : (r.error ?? "Connection test failed."),
      });
    } catch (e) {
      setTestResult({
        ok: false,
        message: e instanceof Error ? e.message : "Connection test failed.",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsSection title="Speech-to-text" icon={AudioLines}>
      <SettingsCard
        title="Transcription service"
        description={
          <>
            Voice messages and audio files are sent to the configured OpenAI-compatible
            <code className="mx-1 font-utility text-compact text-content-secondary">/audio/transcriptions</code>
            endpoint. Audio leaves this instance, so only configure a service you trust.
          </>
        }
      >
        <form className="max-w-lg space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <CheckboxField
            label="Enable speech-to-text"
            hint="Transcripts are shown with messages and delivered to bots after you save."
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={busy !== null}
          />

          <Field label="Endpoint" htmlFor="stt-endpoint" hint="Base URL including /v1">
            <Input
              id="stt-endpoint"
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://api.openai.com/v1 or http://cheers-stt:8000/v1"
              disabled={busy !== null}
            />
          </Field>

          <Field label="Model" htmlFor="stt-model">
            <Input
              id="stt-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="whisper-1"
              disabled={busy !== null}
            />
          </Field>

          <Field
            label="API key"
            htmlFor="stt-api-key"
            hint={loaded?.api_key_set && !clearKey
              ? `Saved ${loaded.api_key_hint} — leave blank to keep it.`
              : "Leave blank if the service does not require authentication."}
          >
            <Input
              id="stt-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={clearKey || busy !== null}
              placeholder={
                loaded?.api_key_set
                  ? "Enter a new key to replace it"
                  : "sk-…"
              }
              autoComplete="off"
            />
            {loaded?.api_key_set && (
              <CheckboxField
                label="Clear the saved key"
                checked={clearKey}
                onChange={(e) => setClearKey(e.target.checked)}
                controlSize="compact"
                disabled={busy !== null}
              />
            )}
          </Field>

          <div className="flex flex-wrap items-center gap-2">
            <ActionButton
              action="save"
              context="settings"
              type="submit"
              accessibleLabel="Save speech-to-text settings"
              disabled={busy !== null}
              loading={busy === "save"}
            />
            <ActionButton
              action="test"
              context="settings"
              accessibleLabel="Test the saved speech-to-text connection"
              onClick={() => void test()}
              disabled={busy !== null || !loaded?.configured}
              loading={busy === "test"}
              title={
                loaded?.configured
                  ? "Send a short test clip using the saved settings"
                  : "Save the settings before testing"
              }
            />
          </div>

          {testResult && (
            <Banner
              severity={testResult.ok ? "success" : "error"}
              icon={testResult.ok ? CircleCheck : AlertCircle}
            >
              {testResult.message}
            </Banner>
          )}
        </form>
      </SettingsCard>
    </SettingsSection>
  );
}
