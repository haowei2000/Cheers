//! `fs.*` — Class 2 agent workspace 文件操作（context-and-environment §2.2，mesh step 6）。
//!
//! 物化路径树，存于 `memory_files`；per-node `version` 乐观锁；局部编辑用 string-replace；
//! 多文件改包一个 DB 事务。每次写操作同时向 `channel_operations` 写一条日志（Class 1 op 记录）。
//!
//! 所有写操作需 Grant（`channel:memory:write`）；读操作只需频道成员。
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use super::{check_bot_in_channel, check_write_permission, ResourceResult};

// ── 读操作（只需频道成员）────────────────────────────────────────────────────

/// `fs.ls` — 列目录（path 前缀匹配子树）。
pub async fn handle_ls(db: &PgPool, bot_id: Uuid, params: &Value) -> ResourceResult {
    let (channel_id, _path) = extract_channel_path(params)?;
    check_bot_in_channel(db, bot_id, channel_id).await?;
    todo!("mesh step 6: SELECT path, version, is_dir FROM memory_files WHERE channel_id=$1 AND path LIKE $2 || '%'")
}

/// `fs.read` — 读单文件。
pub async fn handle_read(db: &PgPool, bot_id: Uuid, params: &Value) -> ResourceResult {
    let (channel_id, _path) = extract_channel_path(params)?;
    check_bot_in_channel(db, bot_id, channel_id).await?;
    todo!("mesh step 6: SELECT content, version FROM memory_files WHERE channel_id=$1 AND path=$2")
}

// ── 写操作（频道成员 + Grant）────────────────────────────────────────────────

/// `fs.write` — 覆盖写（带 if_version 乐观锁）。
pub async fn handle_write(db: &PgPool, bot_id: Uuid, params: &Value) -> ResourceResult {
    let (channel_id, _path) = extract_channel_path(params)?;
    check_write_permission(db, bot_id, channel_id, "channel:memory", "write").await?;
    let _if_version: Option<i64> = params.get("if_version").and_then(|v| v.as_i64());
    let _content: &str = params.get("content").and_then(|v| v.as_str()).unwrap_or("");
    todo!("mesh step 6: tx: UPDATE memory_files SET content, version=version+1 WHERE channel_id AND path AND version=if_version; INSERT channel_operations op_type=fs.write")
}

/// `fs.edit` — 局部 string-replace（old_string→new_string，带 if_version）。
pub async fn handle_edit(db: &PgPool, bot_id: Uuid, params: &Value) -> ResourceResult {
    let (channel_id, _path) = extract_channel_path(params)?;
    check_write_permission(db, bot_id, channel_id, "channel:memory", "write").await?;
    let _old = params.get("old_string").and_then(|v| v.as_str()).unwrap_or("");
    let _new = params.get("new_string").and_then(|v| v.as_str()).unwrap_or("");
    let _if_version: Option<i64> = params.get("if_version").and_then(|v| v.as_i64());
    todo!("mesh step 6: REPLACE in content string; UPDATE version; INSERT channel_operations")
}

/// `fs.append` — 追加写（无乐观锁冲突，适合日志类文件）。
pub async fn handle_append(db: &PgPool, bot_id: Uuid, params: &Value) -> ResourceResult {
    let (channel_id, _path) = extract_channel_path(params)?;
    check_write_permission(db, bot_id, channel_id, "channel:memory", "write").await?;
    let _content: &str = params.get("content").and_then(|v| v.as_str()).unwrap_or("");
    todo!("mesh step 6: UPDATE memory_files SET content=content||$append, version=version+1")
}

/// `fs.rm` — 删除文件或空目录。
pub async fn handle_rm(db: &PgPool, bot_id: Uuid, params: &Value) -> ResourceResult {
    let (channel_id, _path) = extract_channel_path(params)?;
    check_write_permission(db, bot_id, channel_id, "channel:memory", "write").await?;
    todo!("mesh step 6: DELETE FROM memory_files WHERE channel_id=$1 AND path=$2; INSERT channel_operations op_type=fs.rm")
}

/// `fs.mv` — 重命名/移动（更新本节点及所有后代路径）。
pub async fn handle_mv(db: &PgPool, bot_id: Uuid, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("BAD_REQUEST", "missing channel_id"))?;
    check_write_permission(db, bot_id, channel_id, "channel:memory", "write").await?;
    let _from: &str = params.get("from").and_then(|v| v.as_str()).unwrap_or("");
    let _to: &str = params.get("to").and_then(|v| v.as_str()).unwrap_or("");
    todo!("mesh step 6: UPDATE memory_files SET path=replace(path, $from, $to) WHERE channel_id=$1 AND path LIKE $from || '%'")
}

// ── 辅助 ─────────────────────────────────────────────────────────────────────

fn extract_channel_path(params: &Value) -> Result<(Uuid, String), (String, String)> {
    let channel_id = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("BAD_REQUEST", "missing channel_id"))?;
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok((channel_id, path))
}
