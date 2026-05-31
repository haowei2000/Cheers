use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// 发给浏览器的标准外层信封（WIRE_FRAME v1 §4）。
/// `data` 字段对实时层完全不透明，原样转发。
/// 消息体自身可携带 schema 版本（如 MESSAGE_SCHEMA_VERSION）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireFrame {
    /// 协议版本，固定为 1。
    pub v: u8,

    /// 作用域："channel" 或 "user"。
    pub scope: FrameScope,

    /// scope=channel 时存在。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<Uuid>,

    /// 业务事件类型，例如 "message"、"message_stream"、"message_done"。
    #[serde(rename = "type")]
    pub frame_type: String,

    /// 仅流式分层帧（message_stream、bot_trace）存在。
    /// 由 Backend 盖戳，不透传 bot 自报的 seq。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,

    /// 业务数据，对实时层不透明。
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameScope {
    Channel,
    User,
}

impl WireFrame {
    const FRAME_VERSION: u8 = 1;

    pub fn channel(channel_id: Uuid, frame_type: impl Into<String>, data: Value) -> Self {
        Self {
            v: Self::FRAME_VERSION,
            scope: FrameScope::Channel,
            channel_id: Some(channel_id),
            frame_type: frame_type.into(),
            seq: None,
            data,
        }
    }

    pub fn channel_stream(
        channel_id: Uuid,
        frame_type: impl Into<String>,
        seq: u64,
        data: Value,
    ) -> Self {
        Self {
            v: Self::FRAME_VERSION,
            scope: FrameScope::Channel,
            channel_id: Some(channel_id),
            frame_type: frame_type.into(),
            seq: Some(seq),
            data,
        }
    }

    pub fn user(frame_type: impl Into<String>, data: Value) -> Self {
        Self {
            v: Self::FRAME_VERSION,
            scope: FrameScope::User,
            channel_id: None,
            frame_type: frame_type.into(),
            seq: None,
            data,
        }
    }
}
