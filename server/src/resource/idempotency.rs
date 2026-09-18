//! Idempotency keys for resource writes that are not naturally idempotent:
//! `channel.messages.create` (post_message), `channel.files.create` (inbox_deliver)
//! and `fs.append` (desk_append).
//!
//! MCP 2026-07-28 dropped stream resumption: a client whose response stream breaks
//! must re-issue the call as a new request, so a write that already committed would
//! run again. When the caller passes `idempotency_key`, the write claims the key in
//! its own transaction and stores its result before committing. A retry with the same
//! key and arguments gets that result back, flagged with [`REPLAY_FLAG`], without
//! writing again or re-running effects. Reusing a key for different arguments is
//! refused. A concurrent duplicate blocks on the key row until the first transaction
//! settles, so exactly one write lands even across gateway replicas.

use std::io::Write;

use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};

use super::{Principal, ResourceResult};

/// The optional param carrying the caller-chosen key.
pub const PARAM: &str = "idempotency_key";
/// Set on a result replayed from an earlier call, whose effects already ran.
pub const REPLAY_FLAG: &str = "idempotent_replay";
/// How long a key keeps answering with its first result.
const RETENTION_HOURS: i32 = 24;
const MAX_KEY_BYTES: usize = 255;

pub struct IdempotencyKey {
    principal_type: &'static str,
    principal_id: String,
    resource: &'static str,
    key: String,
    request_hash: String,
}

impl IdempotencyKey {
    /// Reads the optional key from a write's params. The request hash covers every
    /// other param, so one key can never stand for two different writes.
    pub fn from_params(
        principal: &Principal,
        resource: &'static str,
        params: &Value,
    ) -> Result<Option<Self>, (String, String)> {
        let key = match params.get(PARAM) {
            None | Some(Value::Null) => return Ok(None),
            Some(Value::String(key)) if !key.trim().is_empty() && key.len() <= MAX_KEY_BYTES => key,
            Some(_) => {
                return Err(super::resource_error(
                    "INVALID_PARAMS",
                    "idempotency_key must be a non-empty string of at most 255 bytes",
                ))
            }
        };
        Ok(Some(Self {
            principal_type: principal.member_type(),
            principal_id: principal.principal_id.to_string(),
            resource,
            key: key.clone(),
            request_hash: request_hash(params),
        }))
    }

    /// The committed result of an earlier call with this key, flagged as a replay.
    pub async fn replay(&self, db: &PgPool) -> Result<Option<Value>, (String, String)> {
        let row = sqlx::query(
            "SELECT request_hash, response FROM resource_idempotency_keys
             WHERE principal_type = $1 AND principal_id = $2 AND resource = $3
               AND idempotency_key = $4
               AND created_at > NOW() - make_interval(hours => $5)",
        )
        .bind(self.principal_type)
        .bind(&self.principal_id)
        .bind(self.resource)
        .bind(&self.key)
        .bind(RETENTION_HOURS)
        .fetch_optional(db)
        .await
        .map_err(super::db_err("idempotency: select key"))?;
        let Some(row) = row else {
            return Ok(None);
        };
        let stored_hash: String = row
            .try_get("request_hash")
            .map_err(super::db_err("idempotency: read request_hash"))?;
        if stored_hash != self.request_hash {
            return Err(super::resource_error(
                "E_IDEMPOTENCY_KEY_REUSED",
                "idempotency_key was already used for a different request",
            ));
        }
        let mut response: Value = row
            .try_get("response")
            .map_err(super::db_err("idempotency: read response"))?;
        if let Some(object) = response.as_object_mut() {
            object.insert(REPLAY_FLAG.to_string(), Value::Bool(true));
        }
        Ok(Some(response))
    }

    /// Claims the key at the start of the write's transaction. `false` means another
    /// call already committed it: drop the transaction and use [`Self::replay_claimed`].
    /// A key past retention is reclaimed for a new write.
    pub async fn claim(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<bool, (String, String)> {
        let claimed = sqlx::query(
            "INSERT INTO resource_idempotency_keys
                 (principal_type, principal_id, resource, idempotency_key, request_hash)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (principal_type, principal_id, resource, idempotency_key) DO UPDATE
                 SET request_hash = EXCLUDED.request_hash, response = NULL, created_at = NOW()
                 WHERE resource_idempotency_keys.created_at <= NOW() - make_interval(hours => $6)
             RETURNING 1",
        )
        .bind(self.principal_type)
        .bind(&self.principal_id)
        .bind(self.resource)
        .bind(&self.key)
        .bind(&self.request_hash)
        .bind(RETENTION_HOURS)
        .fetch_optional(&mut **tx)
        .await
        .map_err(super::db_err("idempotency: claim key"))?;
        Ok(claimed.is_some())
    }

    /// Stores the write's result on the claimed key, before the transaction commits.
    pub async fn complete(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        response: &Value,
    ) -> Result<(), (String, String)> {
        sqlx::query(
            "UPDATE resource_idempotency_keys SET response = $5
             WHERE principal_type = $1 AND principal_id = $2 AND resource = $3
               AND idempotency_key = $4",
        )
        .bind(self.principal_type)
        .bind(&self.principal_id)
        .bind(self.resource)
        .bind(&self.key)
        .bind(response)
        .execute(&mut **tx)
        .await
        .map_err(super::db_err("idempotency: store response"))?;
        Ok(())
    }

    /// Answers a call whose [`Self::claim`] lost to a committed call with the same key.
    pub async fn replay_claimed(&self, db: &PgPool) -> ResourceResult {
        self.replay(db).await?.ok_or_else(|| {
            super::resource_error(
                "E_CONFLICT",
                "a request with this idempotency_key just expired; retry with a new key",
            )
        })
    }
}

/// Deletes keys past retention, returning how many were removed.
pub async fn sweep_expired(db: &PgPool) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        "DELETE FROM resource_idempotency_keys
         WHERE created_at <= NOW() - make_interval(hours => $1)",
    )
    .bind(RETENTION_HOURS)
    .execute(db)
    .await?;
    Ok(result.rows_affected())
}

/// SHA-256 of the params minus the key, with object keys sorted at every level so a
/// retry hashes equally whatever order its transport built the params in. Values are
/// streamed into the hasher: `channel.files.create` carries up to 8 MB of base64.
fn request_hash(params: &Value) -> String {
    let mut hasher = HashWriter(Sha256::new());
    write_canonical(&mut hasher, params, true);
    hex::encode(hasher.0.finalize())
}

struct HashWriter(Sha256);

impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn write_canonical(hasher: &mut HashWriter, value: &Value, top_level: bool) {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<&String> = object
                .keys()
                .filter(|key| !(top_level && key.as_str() == PARAM))
                .collect();
            keys.sort();
            hasher.0.update(b"{");
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    hasher.0.update(b",");
                }
                serde_json::to_writer(&mut *hasher, key).expect("hashing cannot fail");
                hasher.0.update(b":");
                write_canonical(hasher, &object[key], false);
            }
            hasher.0.update(b"}");
        }
        Value::Array(items) => {
            hasher.0.update(b"[");
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    hasher.0.update(b",");
                }
                write_canonical(hasher, item, false);
            }
            hasher.0.update(b"]");
        }
        scalar => serde_json::to_writer(&mut *hasher, scalar).expect("hashing cannot fail"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use uuid::Uuid;

    fn key_for(params: Value) -> Result<Option<IdempotencyKey>, (String, String)> {
        IdempotencyKey::from_params(
            &Principal::bot(Uuid::nil()),
            "channel.messages.create",
            &params,
        )
    }

    #[test]
    fn request_hash_ignores_the_key_and_param_order() {
        let first = key_for(json!({
            "channel_id": "c1", "content": "hi", "mention_names": ["ann"],
            "context_bundle": {"items": [{"b": 2, "a": 1}]}, "idempotency_key": "k1"
        }))
        .unwrap()
        .unwrap();
        let reordered = key_for(json!({
            "idempotency_key": "k2", "mention_names": ["ann"],
            "context_bundle": {"items": [{"a": 1, "b": 2}]}, "content": "hi", "channel_id": "c1"
        }))
        .unwrap()
        .unwrap();
        assert_eq!(first.request_hash, reordered.request_hash);

        let different = key_for(json!({
            "channel_id": "c1", "content": "hi!", "mention_names": ["ann"],
            "context_bundle": {"items": [{"b": 2, "a": 1}]}, "idempotency_key": "k1"
        }))
        .unwrap()
        .unwrap();
        assert_ne!(first.request_hash, different.request_hash);
        // Array order is meaningful and must not be normalised away.
        let mentions_swapped = key_for(json!({
            "channel_id": "c1", "mention_names": ["bob", "ann"], "idempotency_key": "k1"
        }))
        .unwrap()
        .unwrap();
        let mentions = key_for(json!({
            "channel_id": "c1", "mention_names": ["ann", "bob"], "idempotency_key": "k1"
        }))
        .unwrap()
        .unwrap();
        assert_ne!(mentions.request_hash, mentions_swapped.request_hash);
    }

    #[test]
    fn nested_idempotency_key_fields_are_part_of_the_request() {
        let top = key_for(json!({"channel_id": "c1", "idempotency_key": "k"}))
            .unwrap()
            .unwrap();
        let nested = key_for(json!({
            "channel_id": "c1", "idempotency_key": "k", "context_bundle": {"idempotency_key": "x"}
        }))
        .unwrap()
        .unwrap();
        assert_ne!(top.request_hash, nested.request_hash);
    }

    #[test]
    fn absent_or_null_keys_opt_out_and_malformed_keys_are_rejected() {
        assert!(key_for(json!({"channel_id": "c1"})).unwrap().is_none());
        assert!(
            key_for(json!({"channel_id": "c1", "idempotency_key": null}))
                .unwrap()
                .is_none()
        );
        for bad in [json!(""), json!("   "), json!("k".repeat(256)), json!(42)] {
            let error = key_for(json!({"channel_id": "c1", "idempotency_key": bad}))
                .err()
                .expect("malformed key must be rejected");
            assert_eq!(error.0, "INVALID_PARAMS");
        }
        assert!(
            key_for(json!({"channel_id": "c1", "idempotency_key": "k".repeat(255)}))
                .unwrap()
                .is_some()
        );
    }
}
