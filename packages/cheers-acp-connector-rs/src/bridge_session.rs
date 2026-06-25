#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use anyhow::{anyhow, Context};
use serde_json::Value;
use tokio::time::timeout;

use crate::bridge::{
    AcpSecurityHello, BridgeWebSocket, ChannelInfo, ConnectorControlConfig, ConnectorInfo,
    ControlInbound, ControlOutbound, DataInbound, DataOutbound, ReconnectOptions,
    RuntimeDescriptor, ServerCapabilities, BRIDGE_PROTOCOL_VERSION,
};

const DEFAULT_HELLO_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct BridgeSessionConfig {
    pub account_id: String,
    pub bot_token: String,
    pub control_url: String,
    pub data_url: String,
    pub hello_timeout: Duration,
    pub reconnect: ReconnectOptions,
    pub heartbeat_interval: Duration,
    pub send_ack_timeout: Duration,
}

impl BridgeSessionConfig {
    pub fn new(
        account_id: impl Into<String>,
        bot_token: impl Into<String>,
        control_url: impl Into<String>,
        data_url: impl Into<String>,
    ) -> Self {
        Self {
            account_id: account_id.into(),
            bot_token: bot_token.into(),
            control_url: control_url.into(),
            data_url: data_url.into(),
            hello_timeout: DEFAULT_HELLO_TIMEOUT,
            reconnect: ReconnectOptions::default(),
            heartbeat_interval: Duration::from_secs(25),
            send_ack_timeout: Duration::from_secs(10 * 60),
        }
    }

    pub fn with_advanced(
        mut self,
        reconnect_base_ms: u64,
        reconnect_max_ms: u64,
        heartbeat_interval_ms: u64,
        send_ack_timeout_ms: u64,
    ) -> Self {
        self.reconnect = ReconnectOptions {
            base_ms: reconnect_base_ms,
            max_ms: reconnect_max_ms,
            reset_after_ms: reconnect_max_ms,
        };
        self.heartbeat_interval = Duration::from_millis(heartbeat_interval_ms.max(1_000));
        self.send_ack_timeout = Duration::from_millis(send_ack_timeout_ms.max(1));
        self
    }
}

#[derive(Debug, Clone)]
pub struct BridgeReady {
    pub connector: ConnectorInfo,
    pub runtime: RuntimeDescriptor,
    pub connector_capabilities: Option<Value>,
}

impl BridgeReady {
    pub fn acp(runtime_name: impl Into<String>, runtime_version: Option<String>) -> Self {
        Self {
            connector: ConnectorInfo::default(),
            runtime: RuntimeDescriptor {
                protocol: "acp".to_string(),
                name: Some(runtime_name.into()),
                version: runtime_version,
                provider_session_id: None,
                config: None,
                extra: Default::default(),
            },
            connector_capabilities: Some(serde_json::json!({
                "runtime_protocols": ["acp"],
                "runtime_session_control": true,
                "streaming": true,
                "files": true,
                "resource_req": true,
                "permission_request": true,
                "config_options": true,
                "trace": true,
                "workspace": true,
            })),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ControlHelloState {
    pub bot_id: String,
    pub bot_username: String,
    pub bot_display_name: Option<String>,
    pub connection_id: Option<String>,
    pub session_id: String,
    pub memberships: Vec<ChannelInfo>,
    pub acp_security: Option<AcpSecurityHello>,
    pub connector_config: Option<ConnectorControlConfig>,
    pub server_capabilities: Option<ServerCapabilities>,
}

#[derive(Debug, Clone)]
pub struct DataHelloState {
    pub bot_id: String,
    pub connection_id: Option<String>,
    pub session_id: String,
    pub last_event_seq: u64,
    pub acp_security: Option<AcpSecurityHello>,
    pub server_capabilities: Option<ServerCapabilities>,
}

#[derive(Debug, Clone, Default)]
pub struct MembershipSnapshot {
    channel_ids: BTreeSet<String>,
    by_id: BTreeMap<String, ChannelInfo>,
}

impl MembershipSnapshot {
    pub fn replace(&mut self, channels: Vec<ChannelInfo>) {
        self.channel_ids.clear();
        self.by_id.clear();
        for channel in channels {
            self.channel_ids.insert(channel.channel_id.clone());
            self.by_id.insert(channel.channel_id.clone(), channel);
        }
    }

    pub fn join(&mut self, channel: ChannelInfo) {
        self.channel_ids.insert(channel.channel_id.clone());
        self.by_id.insert(channel.channel_id.clone(), channel);
    }

    pub fn leave(&mut self, channel_id: &str) {
        self.channel_ids.remove(channel_id);
        self.by_id.remove(channel_id);
    }

    pub fn contains(&self, channel_id: &str) -> bool {
        self.channel_ids.contains(channel_id)
    }

    pub fn len(&self) -> usize {
        self.channel_ids.len()
    }

    pub fn iter_channels(&self) -> impl Iterator<Item = &ChannelInfo> {
        self.by_id.values()
    }
}

pub struct BridgeSession {
    account_id: String,
    control: BridgeWebSocket,
    data: BridgeWebSocket,
    control_hello: ControlHelloState,
    data_hello: DataHelloState,
    memberships: MembershipSnapshot,
}

pub struct BridgeSessionParts {
    pub account_id: String,
    pub control: BridgeWebSocket,
    pub data: BridgeWebSocket,
    pub control_hello: ControlHelloState,
    pub data_hello: DataHelloState,
    pub memberships: MembershipSnapshot,
}

impl BridgeSession {
    pub async fn connect(config: BridgeSessionConfig, ready: BridgeReady) -> anyhow::Result<Self> {
        let (control, control_hello) = connect_control_stream(&config, &ready).await?;
        let (data, data_hello) = connect_data_stream(&config).await?;
        validate_hello_pair(&control_hello, &data_hello)?;

        let mut memberships = MembershipSnapshot::default();
        memberships.replace(control_hello.memberships.clone());

        Ok(Self {
            account_id: config.account_id,
            control,
            data,
            control_hello,
            data_hello,
            memberships,
        })
    }

    pub fn bot_id(&self) -> &str {
        &self.control_hello.bot_id
    }

    pub fn account_id(&self) -> &str {
        &self.account_id
    }

    pub fn memberships(&self) -> &MembershipSnapshot {
        &self.memberships
    }

    pub fn control_hello(&self) -> &ControlHelloState {
        &self.control_hello
    }

    pub fn data_hello(&self) -> &DataHelloState {
        &self.data_hello
    }

    pub async fn next_control_frame(&mut self) -> anyhow::Result<Option<ControlInbound>> {
        let Some(value) = self.control.next_json().await? else {
            return Ok(None);
        };
        let frame: ControlInbound =
            serde_json::from_value(value).context("failed to decode control frame")?;
        self.apply_control_membership_event(&frame);
        Ok(Some(frame))
    }

    pub async fn next_data_frame(&mut self) -> anyhow::Result<Option<DataInbound>> {
        let Some(value) = self.data.next_json().await? else {
            return Ok(None);
        };
        let frame: DataInbound =
            serde_json::from_value(value).context("failed to decode data frame")?;
        Ok(Some(frame))
    }

    pub async fn send_control(&mut self, frame: &ControlOutbound) -> anyhow::Result<()> {
        self.control.send_json(frame).await
    }

    pub async fn send_data(&mut self, frame: &DataOutbound) -> anyhow::Result<()> {
        self.data.send_json(frame).await
    }

    pub fn into_parts(self) -> BridgeSessionParts {
        BridgeSessionParts {
            account_id: self.account_id,
            control: self.control,
            data: self.data,
            control_hello: self.control_hello,
            data_hello: self.data_hello,
            memberships: self.memberships,
        }
    }

    fn apply_control_membership_event(&mut self, frame: &ControlInbound) {
        match frame {
            ControlInbound::Hello { memberships, .. } => {
                self.memberships.replace(memberships.clone());
            }
            ControlInbound::ChannelJoined { channel, .. } => {
                self.memberships.join(channel.clone());
            }
            ControlInbound::ChannelLeft { channel_id, .. } => {
                self.memberships.leave(channel_id);
            }
            _ => {}
        }
    }
}

pub async fn connect_control_stream(
    config: &BridgeSessionConfig,
    ready: &BridgeReady,
) -> anyhow::Result<(BridgeWebSocket, ControlHelloState)> {
    let mut control = BridgeWebSocket::connect(&config.control_url, &config.bot_token)
        .await
        .with_context(|| {
            format!(
                "failed to connect Agent Bridge control stream for account={}",
                config.account_id
            )
        })?;
    let hello = wait_control_hello(&mut control, config.hello_timeout, &config.account_id).await?;
    control
        .send_json(&ControlOutbound::Ready {
            v: BRIDGE_PROTOCOL_VERSION,
            connector_version: ready.connector.version.clone(),
            runtime: ready.runtime.clone(),
            connector_capabilities: ready.connector_capabilities.clone(),
        })
        .await
        .context("failed to send Agent Bridge ready frame")?;
    Ok((control, hello))
}

pub async fn connect_data_stream(
    config: &BridgeSessionConfig,
) -> anyhow::Result<(BridgeWebSocket, DataHelloState)> {
    let mut data = BridgeWebSocket::connect(&config.data_url, &config.bot_token)
        .await
        .with_context(|| {
            format!(
                "failed to connect Agent Bridge data stream for account={}",
                config.account_id
            )
        })?;
    let hello = wait_data_hello(&mut data, config.hello_timeout, &config.account_id).await?;
    Ok((data, hello))
}

async fn wait_control_hello(
    control: &mut BridgeWebSocket,
    wait: Duration,
    account_id: &str,
) -> anyhow::Result<ControlHelloState> {
    let value = timeout(wait, control.next_json())
        .await
        .with_context(|| format!("control hello timeout account={account_id}"))??
        .ok_or_else(|| anyhow!("control stream closed before hello account={account_id}"))?;
    control_hello_from_value(value)
}

async fn wait_data_hello(
    data: &mut BridgeWebSocket,
    wait: Duration,
    account_id: &str,
) -> anyhow::Result<DataHelloState> {
    let value = timeout(wait, data.next_json())
        .await
        .with_context(|| format!("data hello timeout account={account_id}"))??
        .ok_or_else(|| anyhow!("data stream closed before hello account={account_id}"))?;
    data_hello_from_value(value)
}

fn control_hello_from_value(value: Value) -> anyhow::Result<ControlHelloState> {
    match serde_json::from_value(value).context("failed to decode control hello")? {
        ControlInbound::Hello {
            v,
            bridge_protocol_version,
            bot_id,
            bot_username,
            bot_display_name,
            connection_id,
            session_id,
            memberships,
            acp_security,
            connector_config,
            server_capabilities,
            ..
        } => {
            ensure_supported_version(v, bridge_protocol_version, "control")?;
            Ok(ControlHelloState {
                bot_id,
                bot_username,
                bot_display_name,
                connection_id,
                session_id,
                memberships,
                acp_security,
                connector_config,
                server_capabilities,
            })
        }
        other => Err(anyhow!("expected control hello, got {other:?}")),
    }
}

fn data_hello_from_value(value: Value) -> anyhow::Result<DataHelloState> {
    match serde_json::from_value(value).context("failed to decode data hello")? {
        DataInbound::Hello {
            v,
            bridge_protocol_version,
            stream,
            bot_id,
            connection_id,
            session_id,
            last_event_seq,
            acp_security,
            server_capabilities,
        } => {
            if stream != "data" {
                return Err(anyhow!("expected data hello stream=data, got {stream}"));
            }
            ensure_supported_version(v, bridge_protocol_version, "data")?;
            Ok(DataHelloState {
                bot_id,
                connection_id,
                session_id,
                last_event_seq,
                acp_security,
                server_capabilities,
            })
        }
        other => Err(anyhow!("expected data hello, got {other:?}")),
    }
}

fn ensure_supported_version(
    v: u32,
    bridge_protocol_version: u32,
    stream: &str,
) -> anyhow::Result<()> {
    if v != BRIDGE_PROTOCOL_VERSION || bridge_protocol_version != BRIDGE_PROTOCOL_VERSION {
        return Err(anyhow!(
            "{stream} hello uses unsupported Agent Bridge version frame_v={} bridge_protocol_version={} expected={}",
            v,
            bridge_protocol_version,
            BRIDGE_PROTOCOL_VERSION
        ));
    }
    Ok(())
}

fn validate_hello_pair(control: &ControlHelloState, data: &DataHelloState) -> anyhow::Result<()> {
    if control.bot_id != data.bot_id {
        return Err(anyhow!(
            "control/data hello bot mismatch control={} data={}",
            control.bot_id,
            data.bot_id
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_control_hello_membership_snapshot() {
        let hello = control_hello_from_value(json!({
            "type": "hello",
            "v": 1,
            "bridge_protocol_version": 1,
            "stream": "control",
            "bot_id": "bot-1",
            "bot_username": "helper",
            "bot_display_name": "Helper",
            "connection_id": "conn-1",
            "session_id": "conn-1",
            "memberships": [
                {
                    "channel_id": "channel-1",
                    "channel_name": "general",
                    "channel_type": "public",
                    "workspace_id": "workspace-1",
                    "joined_at": "2026-06-01T10:15:30Z"
                }
            ],
            "server_capabilities": {
                "task_stream": "control",
                "runtime_session_control": true
            }
        }))
        .expect("control hello");

        assert_eq!(hello.bot_id, "bot-1");
        assert_eq!(hello.memberships.len(), 1);
        assert_eq!(hello.memberships[0].channel_id, "channel-1");
    }

    #[test]
    fn parses_data_hello() {
        let hello = data_hello_from_value(json!({
            "type": "hello",
            "v": 1,
            "bridge_protocol_version": 1,
            "stream": "data",
            "bot_id": "bot-1",
            "connection_id": "data-conn-1",
            "session_id": "data-conn-1",
            "last_event_seq": 12,
            "server_capabilities": {
                "resource_req": true,
                "terminal_ack": true,
                "resume": "ack_only"
            }
        }))
        .expect("data hello");

        assert_eq!(hello.bot_id, "bot-1");
        assert_eq!(hello.last_event_seq, 12);
    }

    #[test]
    fn rejects_mismatched_control_and_data_bot() {
        let control = ControlHelloState {
            bot_id: "bot-control".to_string(),
            bot_username: "helper".to_string(),
            bot_display_name: None,
            connection_id: None,
            session_id: "control-session".to_string(),
            memberships: Vec::new(),
            acp_security: None,
            connector_config: None,
            server_capabilities: None,
        };
        let data = DataHelloState {
            bot_id: "bot-data".to_string(),
            connection_id: None,
            session_id: "data-session".to_string(),
            last_event_seq: 0,
            acp_security: None,
            server_capabilities: None,
        };

        assert!(validate_hello_pair(&control, &data).is_err());
    }

    #[test]
    fn membership_snapshot_applies_join_and_leave() {
        let mut snapshot = MembershipSnapshot::default();
        snapshot.replace(vec![ChannelInfo {
            channel_id: "channel-1".to_string(),
            channel_name: Some("general".to_string()),
            channel_type: Some("public".to_string()),
            workspace_id: Some("workspace-1".to_string()),
            joined_at: None,
        }]);
        assert!(snapshot.contains("channel-1"));

        snapshot.join(ChannelInfo {
            channel_id: "channel-2".to_string(),
            channel_name: Some("ops".to_string()),
            channel_type: Some("private".to_string()),
            workspace_id: Some("workspace-1".to_string()),
            joined_at: None,
        });
        assert_eq!(snapshot.len(), 2);

        snapshot.leave("channel-1");
        assert!(!snapshot.contains("channel-1"));
        assert!(snapshot.contains("channel-2"));
    }
}
