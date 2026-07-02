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
