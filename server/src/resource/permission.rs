use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};

// ── 数据结构 ──────────────────────────────────────────────────────────────────

/// bot_grants 表对应的 Rust 结构体。
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct BotGrant {
    pub code: String,
    pub bot_id: String,
    pub scope_type: String,
    pub scope_id: Option<String>,
    pub resource: String,
    pub actions: Vec<String>,
    pub effect: String, // "allow" | "deny"
}

/// evaluate() 的返回值。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluationResult {
    pub effect: Effect,
    /// 命中的 grant code（用于审计日志）
    pub grant_code: Option<String>,
    /// Deny 时的原因
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effect {
    Allow,
    Deny,
}

impl EvaluationResult {
    pub fn allow(grant_code: impl Into<String>) -> Self {
        Self {
            effect: Effect::Allow,
            grant_code: Some(grant_code.into()),
            reason: None,
        }
    }

    pub fn deny(reason: impl Into<String>) -> Self {
        Self {
            effect: Effect::Deny,
            grant_code: None,
            reason: Some(reason.into()),
        }
    }

    pub fn is_allowed(&self) -> bool {
        self.effect == Effect::Allow
    }
}

// ── 权限评估（BOT_PERMISSION §8）─────────────────────────────────────────────

/// 评估 bot 是否有权执行某操作。
///
/// 查询逻辑：
/// 1. 拉取该 bot 所有有效 grant（未过期、未吊销，且 scope 匹配）
/// 2. 筛选匹配 resource + action 的 grant
/// 3. deny-wins：有任何 deny → 返回 Deny；有 allow → 返回 Allow；否则 Deny
///
/// scope 优先级（细 > 粗）：session > user > channel > workspace > global
pub async fn evaluate(
    db: &PgPool,
    bot_id: &str,
    resource: &str,
    action: &str,
    channel_id: Option<&str>,
    workspace_id: Option<&str>,
    user_id: Option<&str>,
    session_id: Option<&str>,
) -> Result<EvaluationResult, sqlx::Error> {
    let now = Utc::now();

    let grants: Vec<BotGrant> = sqlx::query(
        r#"
        SELECT code, bot_id, scope_type, scope_id, resource, actions, effect
        FROM bot_grants
        WHERE bot_id = $1
          AND revoked = FALSE
          AND (expires_at IS NULL OR expires_at > $2)
          AND (
              scope_type = 'global'
              OR (scope_type = 'workspace' AND scope_id = $3)
              OR (scope_type = 'channel'   AND scope_id = $4)
              OR (scope_type = 'user'      AND scope_id = $5)
              OR (scope_type = 'session'   AND scope_id = $6)
          )
        ORDER BY
          CASE scope_type
            WHEN 'session'   THEN 1
            WHEN 'user'      THEN 2
            WHEN 'channel'   THEN 3
            WHEN 'workspace' THEN 4
            ELSE 5
          END
        "#,
    )
    .bind(bot_id)
    .bind(now)
    .bind(workspace_id)
    .bind(channel_id)
    .bind(user_id)
    .bind(session_id)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|row: sqlx::postgres::PgRow| BotGrant {
        code: row.get("code"),
        bot_id: row.get("bot_id"),
        scope_type: row.get("scope_type"),
        scope_id: row.try_get("scope_id").ok(),
        resource: row.get("resource"),
        actions: row.get("actions"),
        effect: row.get("effect"),
    })
    .collect();

    // 筛选匹配 resource + action 的 grant
    let candidates: Vec<&BotGrant> = grants
        .iter()
        .filter(|g| {
            resource_matches(&g.resource, resource) && g.actions.iter().any(|a| a == action)
        })
        .collect();

    // deny-wins
    if let Some(deny) = candidates.iter().find(|g| g.effect == "deny") {
        return Ok(EvaluationResult::deny(format!(
            "denied by grant {}",
            deny.code
        )));
    }
    if let Some(allow) = candidates.iter().find(|g| g.effect == "allow") {
        return Ok(EvaluationResult::allow(allow.code.clone()));
    }

    Ok(EvaluationResult::deny("no matching grant"))
}

/// resource 匹配规则：支持精确匹配和通配符前缀（"channel:*" 匹配 "channel:messages"、"channel:fs" 等）。
fn resource_matches(grant_resource: &str, requested: &str) -> bool {
    if grant_resource == "*" {
        return true;
    }
    if let Some(prefix) = grant_resource.strip_suffix(":*") {
        return requested.starts_with(&format!("{prefix}:")) || requested == prefix;
    }
    grant_resource == requested
}
