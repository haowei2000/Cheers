use super::*;

pub(super) struct CapabilitySigner {
    delegation_id: String,
    kid: Option<String>,
    request_id_prefix: String,
    seq: u64,
    key: SigningKey,
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
        if config.algorithm.to_ascii_lowercase() != "ed25519" {
            return Err(anyhow!(
                "unsupported acpCapability algorithm {}; expected ed25519",
                config.algorithm
            ));
        }
        if let Some(algorithm) = security
            .as_ref()
            .and_then(|value| value.algorithm.as_deref())
        {
            if algorithm.to_ascii_lowercase() != "ed25519" {
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
        }))
    }

    pub(super) fn attach(&mut self, frame: &mut DataOutbound) -> anyhow::Result<()> {
        let Some(frame_type) = signed_frame_type(frame) else {
            return Ok(());
        };
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
        DataOutbound::ResourceReq { .. } => Some("resource_req"),
        DataOutbound::PermissionRequest { .. } => Some("permission_request"),
        DataOutbound::AuthRequired { .. } => Some("auth_required"),
        DataOutbound::SessionUpdate { .. } => Some("session_update"),
        DataOutbound::Trace { .. } => Some("trace"),
        DataOutbound::Auth { .. }
        | DataOutbound::Ping
        | DataOutbound::Resume { .. }
        | DataOutbound::ClaimEvaluationResult { .. }
        | DataOutbound::WorkspaceRes { .. }
        | DataOutbound::WorkspaceEvent { .. }
        | DataOutbound::PermissionCancel { .. }
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
        | DataOutbound::ResourceReq { acp_capability, .. }
        | DataOutbound::PermissionRequest { acp_capability, .. }
        | DataOutbound::AuthRequired { acp_capability, .. }
        | DataOutbound::SessionUpdate { acp_capability, .. }
        | DataOutbound::Trace { acp_capability, .. } => {
            *acp_capability = Some(envelope);
        }
        DataOutbound::Auth { .. }
        | DataOutbound::Ping
        | DataOutbound::Resume { .. }
        | DataOutbound::ClaimEvaluationResult { .. }
        | DataOutbound::WorkspaceRes { .. }
        | DataOutbound::WorkspaceEvent { .. }
        | DataOutbound::PermissionCancel { .. }
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
