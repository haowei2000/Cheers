//! Ed25519 capability-envelope signing for privileged Agent Bridge operations.
//!
//! Private keys remain connector-local. Each signed request receives a fresh
//! timestamp, nonce, and monotonic request identifier before canonicalization.

use std::collections::HashSet;

use super::*;

/// Gateway capability value that lets a stream's later Delta omit the envelope.
pub(super) const DELTA_CAPABILITY_FIRST_PER_STREAM: &str = "first_per_stream";
/// Bound on remembered streams. Overflow only makes later Delta signed again.
const MAX_SIGNED_STREAMS: usize = 4096;

pub(super) struct CapabilitySigner {
    delegation_id: String,
    kid: Option<String>,
    request_id_prefix: String,
    seq: u64,
    key: SigningKey,
    /// Sign only the first Delta of each stream (gateway `delta_capability`).
    per_stream_delta: bool,
    /// Streams whose first Delta was signed on this data connection. The signer
    /// lives for one bridge session, so a reconnect starts empty and re-signs.
    signed_streams: HashSet<String>,
}

impl CapabilitySigner {
    pub(super) fn from_config(
        config: Option<AcpCapabilityConfig>,
        security: Option<AcpSecurityHello>,
    ) -> anyhow::Result<Option<Self>> {
        let require = security
            .as_ref()
            .and_then(|value| value.require_capability)
            .unwrap_or(false);
        if !require {
            return Ok(None);
        }
        let config =
            config.ok_or_else(|| anyhow!("acpCapability is required by Agent Bridge hello"))?;
        if !config.algorithm.eq_ignore_ascii_case("ed25519") {
            return Err(anyhow!(
                "unsupported acpCapability algorithm {}; expected ed25519",
                config.algorithm
            ));
        }
        if let Some(algorithm) = security
            .as_ref()
            .and_then(|value| value.algorithm.as_deref())
        {
            if !algorithm.eq_ignore_ascii_case("ed25519") {
                return Err(anyhow!(
                    "unsupported Agent Bridge acp_security algorithm {}; expected ed25519",
                    algorithm
                ));
            }
        }
        let key_text = read_private_key_text(&config.private_key)?;
        let key = SigningKey::from_pkcs8_pem(&key_text)
            .context("failed to parse acpCapability private key as Ed25519 PKCS#8 PEM")?;
        Ok(Some(Self {
            delegation_id: config.delegation_id,
            kid: config.kid,
            request_id_prefix: config
                .request_id_prefix
                .unwrap_or_else(|| "acp-cap".to_string()),
            seq: 0,
            key,
            per_stream_delta: false,
            signed_streams: HashSet::new(),
        }))
    }

    /// A Delta capability rejection names its stream: sign that stream's next
    /// Delta again so one rejected signature does not lose the rest of it.
    pub(super) fn observe_bridge_error(&mut self, error: &crate::bridge::BridgeErrorFrame) {
        let delta_capability_error = matches!(
            error.code.as_str(),
            "DELTA_CAPABILITY_REQUIRED" | "CAPABILITY_DENIED"
        );
        if let (true, Some(msg_id)) = (delta_capability_error, error.msg_id.as_deref()) {
            self.signed_streams.remove(msg_id);
        }
    }

    /// Follow the gateway's advertised Delta signing mode for this session.
    pub(super) fn set_delta_capability_mode(&mut self, mode: Option<&str>) {
        self.per_stream_delta = mode == Some(DELTA_CAPABILITY_FIRST_PER_STREAM);
    }

    pub(super) fn attach(&mut self, frame: &mut DataOutbound) -> anyhow::Result<()> {
        let Some(frame_type) = signed_frame_type(frame) else {
            return Ok(());
        };
        if self.per_stream_delta {
            match frame {
                DataOutbound::Delta { msg_id, .. } => {
                    if self.signed_streams.contains(msg_id) {
                        return Ok(());
                    }
                    if self.signed_streams.len() >= MAX_SIGNED_STREAMS {
                        self.signed_streams.clear();
                    }
                    self.signed_streams.insert(msg_id.clone());
                }
                DataOutbound::Done { msg_id, .. } | DataOutbound::Error { msg_id, .. } => {
                    self.signed_streams.remove(msg_id);
                }
                _ => {}
            }
        }
        let mut value = serde_json::to_value(&*frame)?;
        if let Some(obj) = value.as_object_mut() {
            obj.remove("acp_capability");
        }
        self.seq += 1;
        let ts = Utc::now().timestamp();
        let nonce = Uuid::new_v4().to_string();
        let request_id = format!("{}-{}-{}", self.request_id_prefix, ts, self.seq);
        let payload = canonical_serialize(&value);
        let signable = format!(
            "anx-cap|v1|type={frame_type}|kid={}|ts={ts}|nonce={nonce}|request={request_id}|payload={payload}",
            self.delegation_id
        );
        let signature: Signature = self.key.sign(signable.as_bytes());
        let envelope = AcpCapabilityEnvelope {
            delegation_id: self.delegation_id.clone(),
            ts,
            nonce,
            signature: BASE64.encode(signature.to_bytes()),
            request_id: Some(request_id),
            algorithm: Some("ed25519".to_string()),
            kid: self.kid.clone(),
        };
        attach_envelope(frame, envelope);
        Ok(())
    }
}

pub(super) fn read_private_key_text(value: &str) -> anyhow::Result<String> {
    if let Some(path) = value.strip_prefix("file:") {
        std::fs::read_to_string(path.trim())
            .with_context(|| format!("failed to read acpCapability private key {}", path.trim()))
    } else {
        Ok(value.to_string())
    }
}

pub(super) fn signed_frame_type(frame: &DataOutbound) -> Option<&'static str> {
    match frame {
        DataOutbound::Delta { .. } => Some("delta"),
        DataOutbound::Done { .. } => Some("done"),
        DataOutbound::Error { .. } => Some("error"),
        DataOutbound::Send { .. } => Some("send"),
        DataOutbound::PermissionRequest { .. } => Some("permission_request"),
        DataOutbound::ElicitationRequest { .. } => Some("elicitation_request"),
        DataOutbound::AuthRequired { .. } => Some("auth_required"),
        DataOutbound::SessionUpdate { .. } => Some("session_update"),
        DataOutbound::Trace { .. } => Some("trace"),
        DataOutbound::Auth { .. }
        | DataOutbound::Ping
        | DataOutbound::Resume { .. }
        | DataOutbound::ClaimEvaluationResult { .. }
        | DataOutbound::SuggestionResult { .. }
        | DataOutbound::WorkspaceRes { .. }
        | DataOutbound::WorkspaceEvent { .. }
        | DataOutbound::PermissionCancel { .. }
        | DataOutbound::ElicitationCancel { .. }
        | DataOutbound::ElicitationComplete { .. }
        | DataOutbound::AuthCancel { .. }
        | DataOutbound::AcpEvent { .. }
        | DataOutbound::FileUpload { .. }
        | DataOutbound::Unknown => None,
    }
}

pub(super) fn attach_envelope(frame: &mut DataOutbound, envelope: AcpCapabilityEnvelope) {
    match frame {
        DataOutbound::Delta { acp_capability, .. }
        | DataOutbound::Done { acp_capability, .. }
        | DataOutbound::Error { acp_capability, .. }
        | DataOutbound::Send { acp_capability, .. }
        | DataOutbound::PermissionRequest { acp_capability, .. }
        | DataOutbound::ElicitationRequest { acp_capability, .. }
        | DataOutbound::AuthRequired { acp_capability, .. }
        | DataOutbound::SessionUpdate { acp_capability, .. }
        | DataOutbound::Trace { acp_capability, .. } => {
            *acp_capability = Some(envelope);
        }
        DataOutbound::Auth { .. }
        | DataOutbound::Ping
        | DataOutbound::Resume { .. }
        | DataOutbound::ClaimEvaluationResult { .. }
        | DataOutbound::SuggestionResult { .. }
        | DataOutbound::WorkspaceRes { .. }
        | DataOutbound::WorkspaceEvent { .. }
        | DataOutbound::PermissionCancel { .. }
        | DataOutbound::ElicitationCancel { .. }
        | DataOutbound::ElicitationComplete { .. }
        | DataOutbound::AuthCancel { .. }
        | DataOutbound::AcpEvent { .. }
        | DataOutbound::FileUpload { .. }
        | DataOutbound::Unknown => {}
    }
}

pub(super) fn canonical_serialize(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_serialize)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut entries: BTreeMap<&String, &Value> = BTreeMap::new();
            for (key, value) in map {
                entries.insert(key, value);
            }
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()),
                        canonical_serialize(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn signer() -> CapabilitySigner {
        CapabilitySigner {
            delegation_id: Uuid::new_v4().to_string(),
            kid: None,
            request_id_prefix: "test".to_string(),
            seq: 0,
            key: SigningKey::from_bytes(&[7u8; 32]),
            per_stream_delta: false,
            signed_streams: HashSet::new(),
        }
    }

    fn frame(value: serde_json::Value) -> DataOutbound {
        serde_json::from_value(value).expect("frame parses")
    }

    fn delta(msg_id: &str) -> DataOutbound {
        frame(json!({"type": "delta", "msg_id": msg_id, "seq": 1, "delta": "x"}))
    }

    fn signed(signer: &mut CapabilitySigner, mut frame: DataOutbound) -> bool {
        signer.attach(&mut frame).expect("attach");
        serde_json::to_value(&frame)
            .unwrap()
            .get("acp_capability")
            .is_some()
    }

    #[test]
    fn every_delta_is_signed_without_gateway_support() {
        let mut signer = signer();
        signer.set_delta_capability_mode(None);
        assert!(signed(&mut signer, delta("m")));
        assert!(signed(&mut signer, delta("m")));
    }

    #[test]
    fn first_per_stream_signs_first_delta_and_every_terminal() {
        let mut signer = signer();
        signer.set_delta_capability_mode(Some(DELTA_CAPABILITY_FIRST_PER_STREAM));
        assert!(signed(&mut signer, delta("a")));
        assert!(!signed(&mut signer, delta("a")));
        assert!(
            signed(&mut signer, delta("b")),
            "each stream signs its own first Delta"
        );
        let done = frame(json!({"type": "done", "client_msg_id": "c", "msg_id": "a"}));
        assert!(signed(&mut signer, done), "terminal frames stay signed");
        assert!(
            signed(&mut signer, delta("a")),
            "a finished stream re-signs"
        );
    }

    #[test]
    fn a_named_delta_rejection_makes_the_next_delta_signed_again() {
        let mut signer = signer();
        signer.set_delta_capability_mode(Some(DELTA_CAPABILITY_FIRST_PER_STREAM));
        assert!(signed(&mut signer, delta("a")));
        assert!(!signed(&mut signer, delta("a")));

        let error = |code: &str, msg_id: Option<&str>| crate::bridge::BridgeErrorFrame {
            v: 1,
            code: code.to_string(),
            detail: None,
            request_id: None,
            client_msg_id: None,
            msg_id: msg_id.map(str::to_string),
            retryable: Some(true),
        };
        signer.observe_bridge_error(&error("INVALID_FRAME", Some("a")));
        signer.observe_bridge_error(&error("DELTA_CAPABILITY_REQUIRED", None));
        assert!(
            !signed(&mut signer, delta("a")),
            "unrelated errors keep the binding"
        );

        signer.observe_bridge_error(&error("DELTA_CAPABILITY_REQUIRED", Some("a")));
        assert!(signed(&mut signer, delta("a")));
        assert!(!signed(&mut signer, delta("a")));
    }
}
