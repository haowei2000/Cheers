use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// 进程内投递单元。fan-out 给 N 个连接时只增引用计数，不深拷贝 `data`；
/// JSON 也只在首个写循环取用时序列化一次（见 `WireFrame::to_json`）。
pub type SharedFrame = Arc<WireFrame>;

/// 发给浏览器的标准外层信封（WIRE_FRAME v1 §4）。
/// `data` 字段对实时层完全不透明，原样转发。
/// 消息体自身可携带 schema 版本（如 MESSAGE_SCHEMA_VERSION）。
#[derive(Debug, Serialize, Deserialize)]
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

    /// 序列化缓存。帧进入 `SharedFrame` 后不可变，缓存不会过期；`Clone` 不复制
    /// 缓存，克隆后修改字段也不会发出旧 JSON。
    #[serde(skip)]
    encoded: OnceLock<Arc<str>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameScope {
    Channel,
    User,
}

impl Clone for WireFrame {
    fn clone(&self) -> Self {
        Self {
            v: self.v,
            scope: self.scope.clone(),
            channel_id: self.channel_id,
            frame_type: self.frame_type.clone(),
            seq: self.seq,
            data: self.data.clone(),
            encoded: OnceLock::new(),
        }
    }
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
            encoded: OnceLock::new(),
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
            encoded: OnceLock::new(),
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
            encoded: OnceLock::new(),
        }
    }

    /// 编码后的 JSON，首次调用时序列化并缓存，同一帧的其余订阅者复用。
    pub fn to_json(&self) -> serde_json::Result<Arc<str>> {
        if let Some(encoded) = self.encoded.get() {
            return Ok(encoded.clone());
        }
        let encoded: Arc<str> = serde_json::to_string(self)?.into();
        Ok(self.encoded.get_or_init(|| encoded).clone())
    }

    /// 终态帧：先落 PG 再广播，承诺不丢（I6）。背压时不静默丢弃，
    /// 而是关闭连接让客户端走 REST 补齐。其余（message_stream 等）可丢。
    pub fn is_terminal(&self) -> bool {
        if self.frame_type == "bot_trace" {
            return self
                .data
                .get("is_terminal")
                .and_then(Value::as_bool)
                .unwrap_or_else(|| {
                    crate::domain::trace::is_terminal_status(
                        self.data.get("status").and_then(Value::as_str),
                    )
                });
        }
        matches!(
            self.frame_type.as_str(),
            "message"
                | "message_done"
                | "message_deleted"
                | "notification"
                | "notification_resolved"
                | "bot_unavailable"
                | "voice_transcript_final"
                | "task_claim_created"
                | "task_claim_updated"
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_clone_re_encodes_its_own_fields() {
        let frame = WireFrame::user("message_stream", json!({"delta": "a"}));
        assert!(frame.to_json().unwrap().contains("\"a\""));
        let mut changed = frame.clone();
        changed.data = json!({"delta": "b"});
        assert!(changed.to_json().unwrap().contains("\"b\""));
        assert!(frame.to_json().unwrap().contains("\"a\""));
    }

    #[test]
    fn activity_delivery_and_resolution_are_terminal() {
        assert!(WireFrame::user("notification", json!({})).is_terminal());
        assert!(WireFrame::user("notification_resolved", json!({})).is_terminal());
    }
}
