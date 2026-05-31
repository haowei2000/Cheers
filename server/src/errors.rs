use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

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

    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),

    #[error("internal error: {0}")]
    Internal(String),
}

impl AppError {
    fn status(&self) -> StatusCode {
        match self {
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Conflict(_) => StatusCode::CONFLICT,
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
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        let body = Json(json!({ "detail": self.to_string() }));
        (status, body).into_response()
    }
}

/// 便于在 handler 里用 `?` 把任意错误转成 500
impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        Self::Internal(e.to_string())
    }
}
