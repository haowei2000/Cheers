import { apiJson } from "./client";

// Admin-only instance settings (system_settings). Today: the speech-to-text
// (STT) endpoint used by the gateway's transcription worker.

export interface SttSettings {
  configured: boolean;
  enabled: boolean;
  endpoint: string;
  model: string;
  /** Whether a key is stored server-side — the key itself is never returned. */
  api_key_set: boolean;
  /** Masked tail of the stored key ("***abc1") so admins can tell keys apart. */
  api_key_hint: string | null;
}

export async function getSttSettings(): Promise<SttSettings> {
  return apiJson<SttSettings>(`/admin/settings/stt`);
}

export interface SttSettingsUpdate {
  enabled: boolean;
  endpoint: string;
  model: string;
  /** Omit = keep the stored key; "" = clear it; anything else = replace it. */
  api_key?: string;
}

export async function putSttSettings(update: SttSettingsUpdate): Promise<SttSettings> {
  return apiJson<SttSettings>(`/admin/settings/stt`, {
    method: "PUT",
    body: JSON.stringify(update),
  });
}

export interface SttTestResult {
  ok: boolean;
  transcript?: string;
  error?: string;
}

/** Server-side connectivity test using the SAVED settings (save first, then test). */
export async function testSttSettings(): Promise<SttTestResult> {
  return apiJson<SttTestResult>(`/admin/settings/stt/test`, { method: "POST" });
}

// Runtime settings: admin overrides of env-configured defaults, applied without
// a restart. Every change records its author and reason.

export interface RuntimeSetting {
  key: string;
  label: string;
  description: string;
  unit: string;
  min: number;
  max: number;
  default_value: number;
  /** Null when the setting is on its default. */
  override_value: number | null;
  effective_value: number;
}

export interface RuntimeSettingRevision {
  id: string;
  /** Null means the setting was on its default. */
  old_value: number | null;
  new_value: number | null;
  actor_id: string;
  /** Null when the author's account no longer exists. */
  actor_name: string | null;
  reason: string;
  created_at: string;
}

export async function listRuntimeSettings(): Promise<RuntimeSetting[]> {
  const body = await apiJson<{ settings: RuntimeSetting[] }>(`/admin/settings/runtime`);
  return body.settings;
}

/** `value: null` removes the override and returns to the default. */
export async function putRuntimeSetting(
  key: string,
  update: { value: number | null; reason: string },
): Promise<RuntimeSetting[]> {
  const body = await apiJson<{ settings: RuntimeSetting[] }>(
    `/admin/settings/runtime/${encodeURIComponent(key)}`,
    { method: "PUT", body: JSON.stringify(update) },
  );
  return body.settings;
}

export async function listRuntimeSettingRevisions(key: string): Promise<RuntimeSettingRevision[]> {
  const body = await apiJson<{ revisions: RuntimeSettingRevision[] }>(
    `/admin/settings/runtime/${encodeURIComponent(key)}/revisions`,
  );
  return body.revisions;
}
