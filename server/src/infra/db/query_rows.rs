//! Typed projections shared by gateway query producers and domain converters.

#[derive(Debug, Clone)]
pub(crate) struct MessageRow {
    pub(crate) id: String,
    pub(crate) channel_id: String,
    pub(crate) sender_type: String,
    pub(crate) sender_id: String,
    pub(crate) channel_seq: Option<i64>,
    pub(crate) sender_name: Option<String>,
    pub(crate) content: String,
    pub(crate) msg_type: String,
    pub(crate) is_partial: bool,
    pub(crate) is_deleted: bool,
    pub(crate) file_ids: Option<serde_json::Value>,
    pub(crate) reply_to_msg_id: Option<String>,
    pub(crate) thread_root_msg_id: Option<String>,
    pub(crate) created_at: chrono::DateTime<chrono::Utc>,
    pub(crate) content_data: Option<serde_json::Value>,
    pub(crate) context_bundle: Option<serde_json::Value>,
    pub(crate) trace_count: Option<i64>,
    pub(crate) trace_has_failure: Option<bool>,
    pub(crate) depth: i32,
}

#[derive(Debug, Clone)]
pub(crate) struct TranscriptRow {
    pub(crate) segment_id: String,
    pub(crate) voice_session_id: String,
    pub(crate) channel_id: String,
    pub(crate) participant_session_id: String,
    pub(crate) user_id: String,
    pub(crate) provider_segment_id: String,
    pub(crate) provider_event_id: String,
    pub(crate) track_id: String,
    pub(crate) channel_seq: i64,
    pub(crate) text: String,
    pub(crate) started_at_ms: i64,
    pub(crate) ended_at_ms: i64,
    pub(crate) language: Option<String>,
    pub(crate) confidence: Option<f64>,
    pub(crate) supersedes_segment_id: Option<String>,
    pub(crate) finalized_at: chrono::DateTime<chrono::Utc>,
    pub(crate) created_at: chrono::DateTime<chrono::Utc>,
    pub(crate) deleted_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone)]
pub(crate) struct InviteLinkRow {
    pub(crate) link_id: String,
    pub(crate) token: String,
    pub(crate) workspace_id: String,
    pub(crate) channel_id: Option<String>,
    pub(crate) channel_name: Option<String>,
    pub(crate) created_by_name: Option<String>,
    pub(crate) created_at: Option<String>,
    pub(crate) expires_at: Option<String>,
    pub(crate) max_uses: Option<i32>,
    pub(crate) use_count: i32,
    pub(crate) expired: Option<bool>,
    pub(crate) exhausted: Option<bool>,
}

#[derive(Debug, Clone)]
pub(crate) struct VoicePresenceRow {
    pub(crate) channel_id: String,
    pub(crate) voice_session_id: String,
    pub(crate) status: String,
    pub(crate) user_id: Option<String>,
    pub(crate) display_name: Option<String>,
    pub(crate) avatar_url: Option<String>,
    pub(crate) mic_published_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone)]
pub(crate) struct ScheduledMessageRow {
    pub(crate) task_id: String,
    pub(crate) channel_id: String,
    pub(crate) title: String,
    pub(crate) content: String,
    pub(crate) mention_ids: serde_json::Value,
    pub(crate) schedule_kind: String,
    pub(crate) run_at: Option<chrono::DateTime<chrono::Utc>>,
    pub(crate) interval_minutes: Option<i32>,
    pub(crate) next_run_at: Option<chrono::DateTime<chrono::Utc>>,
    pub(crate) enabled: bool,
    pub(crate) source_extension_id: Option<String>,
    pub(crate) source_automation_id: Option<String>,
    pub(crate) last_run_at: Option<chrono::DateTime<chrono::Utc>>,
    pub(crate) last_error: Option<String>,
    pub(crate) consecutive_failures: i32,
    pub(crate) created_at: chrono::DateTime<chrono::Utc>,
    pub(crate) updated_at: chrono::DateTime<chrono::Utc>,
    pub(crate) local_time: Option<chrono::NaiveTime>,
    pub(crate) timezone: Option<String>,
    pub(crate) retry_attempt: i32,
    pub(crate) channel_name: String,
}

#[derive(Debug, Clone)]
pub(crate) struct FleetPermissionRow {
    pub(crate) msg_id: String,
    pub(crate) channel_id: String,
    pub(crate) channel_name: String,
    pub(crate) sender_id: String,
    pub(crate) content_data: Option<serde_json::Value>,
    pub(crate) created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone)]
pub(crate) struct FleetAgentRow {
    pub(crate) bot_id: String,
    pub(crate) channel_id: String,
    pub(crate) channel_name: String,
    pub(crate) bot_name: Option<String>,
    pub(crate) status_text: Option<String>,
    pub(crate) status_emoji: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct TraceRow {
    pub(crate) id: String,
    pub(crate) msg_id: String,
    pub(crate) channel_id: String,
    pub(crate) bot_id: Option<String>,
    pub(crate) task_id: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) trace_seq: i64,
    pub(crate) stream: String,
    pub(crate) kind: String,
    pub(crate) phase: String,
    pub(crate) status: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) message: Option<String>,
    pub(crate) data: Option<serde_json::Value>,
    pub(crate) request_id: Option<String>,
    pub(crate) approval_kind: Option<String>,
    pub(crate) decision: Option<String>,
    pub(crate) option_id: Option<String>,
    pub(crate) actor_id: Option<String>,
    pub(crate) created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone)]
pub(crate) struct PermissionRow {
    pub(crate) msg_id: String,
    pub(crate) channel_id: String,
    pub(crate) sender_id: String,
    pub(crate) channel_seq: Option<i64>,
    pub(crate) content: String,
    pub(crate) content_data: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub(crate) struct MonitoringRow {
    pub(crate) channel_id: String,
    pub(crate) bot_id: String,
    pub(crate) mode: String,
    pub(crate) scope: String,
    pub(crate) debounce_seconds: i32,
    pub(crate) min_interval_seconds: i32,
    pub(crate) max_evaluations_per_hour: i32,
    pub(crate) batch_size: i32,
    pub(crate) confidence_threshold: Option<f64>,
    pub(crate) last_evaluated_seq: i64,
    pub(crate) policy: serde_json::Value,
}

#[derive(Debug, Clone)]
pub(crate) struct BindingRow {
    pub(crate) channel_id: String,
    pub(crate) integration_id: String,
    pub(crate) installation_id: String,
    pub(crate) external_kind: String,
    pub(crate) external_id: String,
    pub(crate) created_by: String,
}
