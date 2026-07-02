//! Thin client for an OpenAI-compatible speech-to-text service.
//!
//! Like the Gotenberg client, the gateway feeds the service raw audio bytes pulled
//! from S3 — the STT endpoint never gets object-store credentials or a fetchable
//! URL. The endpoint itself is admin-configured at runtime (system_settings), so
//! this client applies basic outbound hardening regardless of where it points:
//! no redirect following, request timeout, and a response size cap.

use std::time::Duration;

/// Longest transcript body accepted from the STT service. A transcript of a
/// 16 MB (upload cap) audio file is at most a few hundred KB of text; anything
/// bigger is a misbehaving endpoint, not a transcript.
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

/// Build the outbound HTTP client used for STT calls: generous timeout (audio
/// transcription is slow), and no redirect following — a redirect from a
/// configured endpoint is treated as a misconfiguration, not followed blindly.
pub fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Transcribe audio via `{base}/audio/transcriptions` (OpenAI-compatible).
///
/// `base_url` is the OpenAI-style base **including** any `/v1` prefix, e.g.
/// `https://api.openai.com/v1` or `http://cheers-stt:8000/v1`. `filename` must
/// carry the real extension — most Whisper servers sniff the container format
/// from it. Returns the transcript text.
pub async fn transcribe(
    http: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    filename: &str,
    bytes: Vec<u8>,
) -> anyhow::Result<String> {
    let url = format!("{}/audio/transcriptions", base_url.trim_end_matches('/'));
    let part = reqwest::multipart::Part::bytes(bytes).file_name(filename.to_string());
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model.to_string())
        .text("response_format", "json");

    let mut req = http.post(url).multipart(form);
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        req = req.bearer_auth(key.trim());
    }

    let resp = req.send().await?;
    let status = resp.status();
    if !status.is_success() {
        let body: String = resp
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(500)
            .collect();
        anyhow::bail!("stt transcribe failed ({status}): {body}");
    }
    let body = resp.bytes().await?;
    if body.len() > MAX_RESPONSE_BYTES {
        anyhow::bail!("stt response too large ({} bytes)", body.len());
    }
    // OpenAI-compatible JSON: { "text": "..." }. Some servers also return plain
    // text despite response_format=json — accept that as a fallback.
    let text = match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(v) => v
            .get("text")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| anyhow::anyhow!("stt response JSON has no `text` field"))?,
        Err(_) => String::from_utf8_lossy(&body).into_owned(),
    };
    Ok(text.trim().to_string())
}

/// A minimal valid WAV (0.5 s of 8 kHz mono 16-bit silence, ~8 KB) used by the
/// admin "test connection" button — proves auth + model + endpoint work without
/// shipping a fixture file.
pub fn silence_wav() -> Vec<u8> {
    const SAMPLE_RATE: u32 = 8000;
    const SAMPLES: u32 = SAMPLE_RATE / 2; // 0.5s
    let data_len = SAMPLES * 2; // 16-bit mono
    let mut wav = Vec::with_capacity(44 + data_len as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.resize(44 + data_len as usize, 0);
    wav
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 自检用静音 WAV：RIFF 头正确、总长 = 44 头 + data。
    #[test]
    fn silence_wav_is_well_formed() {
        let wav = silence_wav();
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        let data_len = u32::from_le_bytes(wav[40..44].try_into().unwrap());
        assert_eq!(wav.len(), 44 + data_len as usize);
    }
}
