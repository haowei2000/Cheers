use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

/// 统一应用错误类型。
/// transport 层把 domain/infra 错误转成这个，再转成 HTTP 响应。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not found")]
    NotFound,

    #[error("unauthorized: {0}")]
    Unauthorized(String),

    #[error("forbidden: {0}")]
    Forbidden(String),

    #[error("bad request: {0}")]
    BadRequest(String),

    #[error("conflict: {0}")]
    Conflict(String),

    #[error("precondition required: {0}")]
    PreconditionRequired(String),

    #[error("payload too large: {0}")]
    PayloadTooLarge(String),

    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),

    #[error("internal error: {0}")]
    Internal(String),

    #[error("service unavailable: {0}")]
    ServiceUnavailable(String),

    #[error("too many requests")]
    TooManyRequests { retry_after_secs: u64 },
}

impl AppError {
    fn status(&self) -> StatusCode {
        match self {
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::PreconditionRequired(_) => StatusCode::PRECONDITION_REQUIRED,
            Self::PayloadTooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Db(e) => {
                // 唯一约束冲突 → 409
                if let sqlx::Error::Database(ref de) = e {
                    if de.is_unique_violation() {
                        return StatusCode::CONFLICT;
                    }
                }
                StatusCode::INTERNAL_SERVER_ERROR
            }
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::ServiceUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::TooManyRequests { .. } => StatusCode::TOO_MANY_REQUESTS,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        let retry_after = match &self {
            Self::TooManyRequests { retry_after_secs } => Some(*retry_after_secs),
            _ => None,
        };
        // A Conflict may carry a JSON *object* as its payload — the write-conflict
        // path ships the connector's `current_etag` / `size_bytes` so the client can
        // rebase and retry. When it does, that object IS the response body; every
        // other Conflict (a plain string) falls through to the generic `{ "detail" }`
        // shape below. 4xx bodies are caller-facing, so this is safe to expose.
        if let Self::Conflict(payload) | Self::PreconditionRequired(payload) = &self {
            if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(payload) {
                return (status, Json(Value::Object(map))).into_response();
            }
        }
        // 5xx 细节（SQL 状态、约束名、连接串、内部路径）不得回给客户端：服务端
        // 记日志，对外返回通用串。4xx 是调用方可修复的错误，原样透出是安全的。
        let detail = match &self {
            Self::Db(e) if status == StatusCode::CONFLICT => {
                tracing::debug!(error = %e, "unique-constraint conflict");
                "conflict".to_string()
            }
            Self::Db(e) => {
                tracing::error!(error = %e, "database error");
                "internal error".to_string()
            }
            Self::Internal(msg) => {
                tracing::error!(detail = %msg, "internal error");
                "internal error".to_string()
            }
            other => other.to_string(),
        };
        let mut resp = (status, Json(json!({ "detail": detail }))).into_response();
        if let Some(secs) = retry_after {
            if let Ok(hv) = axum::http::HeaderValue::from_str(&secs.to_string()) {
                resp.headers_mut()
                    .insert(axum::http::header::RETRY_AFTER, hv);
            }
        }
        resp
    }
}

/// 便于在 handler 里用 `?` 把任意错误转成 500
impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        Self::Internal(e.to_string())
    }
}
