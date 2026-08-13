//! `fs.*` — Class 2 agent workspace file operations (mesh step 6).
//!
//! Files live in `context_files` using materialized paths. Writes are transactional:
//! update the file tree, allocate the shared `channel_seq`, then append a
//! `channel_operations` record. Operations are inert for dispatch and discovered
//! by bots via `channel.activity.read`.
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;
use yamlpath::{Component as YamlComponent, Document as YamlDocument, FeatureKind, Route};

use crate::domain::channel_seq;

use super::{authorize_channel_read, authorize_channel_write, Principal, ResourceResult};

// ── Reads ────────────────────────────────────────────────────────────────────

/// `fs.ls` — list a subtree by path prefix. Root is `path=""`.
pub async fn handle_ls(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let (channel_id, path) = extract_channel_path(params, true)?;
    authorize_channel_read(db, principal, channel_id).await?;

    let rows = sqlx::query(
        "SELECT path, version, is_dir, LENGTH(content)::bigint AS size_bytes,
                created_at, updated_at
         FROM context_files
         WHERE channel_id = $1
           AND ($2 = '' OR path = $2 OR left(path, char_length($2) + 1) = $2 || '/')
         ORDER BY is_dir DESC, path ASC",
    )
    .bind(channel_id.to_string())
    .bind(&path)
    .fetch_all(db)
    .await
    .map_err(super::db_err("fs.ls: select context_files"))?;

    let entries: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            json!({
                "path": row.try_get::<String, _>("path").unwrap_or_default(),
                "version": row.try_get::<i64, _>("version").unwrap_or(0),
                "is_dir": row.try_get::<bool, _>("is_dir").unwrap_or(false),
                "size_bytes": row.try_get::<i64, _>("size_bytes").unwrap_or(0),
                "created_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
                "updated_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at").ok(),
            })
        })
        .collect();

    Ok(json!({
        "channel_id": channel_id,
        "path": path,
        "entries": entries,
    }))
}

/// `fs.read` — read one file.
pub async fn handle_read(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let (channel_id, path) = extract_channel_path(params, false)?;
    authorize_channel_read(db, principal, channel_id).await?;

    let row = sqlx::query(
        "SELECT path, content, version, is_dir, created_at, updated_at
         FROM context_files
         WHERE channel_id = $1 AND path = $2",
    )
    .bind(channel_id.to_string())
    .bind(&path)
    .fetch_optional(db)
    .await
    .map_err(super::db_err("fs.read: select context_file"))?
    .ok_or_else(|| super::not_found("file"))?;

    let full = row.try_get::<String, _>("content").unwrap_or_default();
    // Optional 1-indexed inclusive line window (docs/design/RESOURCE_CONTEXT.md —
    // passage picking). When present, return just that slice + the clamped range
    // so a picked paragraph rides as a scoped ref, not the whole file.
    let start = params.get("start_line").and_then(Value::as_i64);
    let end = params.get("end_line").and_then(Value::as_i64);
    let (content, range) = match slice_lines(&full, start, end) {
        Some((text, s, e)) => (text, Some((s, e))),
        None => (full, None),
    };

    // Parsed representation for structured board files (whole-file reads only — a line
    // window is a text slice, not a document). YAML is a storage format for humans and
    // agents; the wire is JSON, so clients with no YAML parser (native iOS/Android)
    // can render lenses. `null` when the file doesn't parse — the client falls back to
    // the editor over `content`. See docs/arch/WORKBENCH_WRITEBACK.md.
    let data = if range.is_none() {
        parse_structured(&path, &content)
    } else {
        None
    };

    Ok(json!({
        "channel_id": channel_id,
        "path": row.try_get::<String, _>("path").unwrap_or(path),
        "content": content,
        "data": data,
        "version": row.try_get::<i64, _>("version").unwrap_or(0),
        "is_dir": row.try_get::<bool, _>("is_dir").unwrap_or(false),
        // Present only for a ranged read: the actual (clamped) line window returned.
        "start_line": range.map(|(s, _)| s),
        "end_line": range.map(|(_, e)| e),
        "created_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
        "updated_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at").ok(),
    }))
}

/// Parse a structured file to a JSON value by extension class. YAML covers `.yaml`/
/// `.yml` (serde_yaml is YAML 1.2: a bare `no` stays a string — resolving the 1.1
/// ambiguity ONCE, server-side, instead of per client parser); `.json` parses as JSON.
/// Everything else — and anything unparseable — is `None`, never an error: prose is
/// not a board, and a half-written file must not break reading it.
fn parse_structured(path: &str, content: &str) -> Option<Value> {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "yaml" | "yml" => serde_yaml::from_str::<Value>(content).ok(),
        "json" => serde_json::from_str::<Value>(content).ok(),
        _ => None,
    }
}

/// Slice `content` to a 1-indexed inclusive `[start, end]` line window. Returns
/// the sliced text plus the clamped `(start, end)` actually used, or `None` when
/// no usable range was requested (caller then returns the whole file). Missing
/// bound → open on that side; out-of-order or out-of-bounds bounds are clamped to
/// the file so a bad range yields a valid (possibly empty) slice, never an error.
fn slice_lines(content: &str, start: Option<i64>, end: Option<i64>) -> Option<(String, i64, i64)> {
    if start.is_none() && end.is_none() {
        return None;
    }
    let lines: Vec<&str> = content.split('\n').collect();
    let n = lines.len() as i64;
    if n == 0 {
        return None;
    }
    let s = start.unwrap_or(1).max(1).min(n);
    let e = end.unwrap_or(n).max(s).min(n);
    let slice = lines[(s as usize - 1)..(e as usize)].join("\n");
    Some((slice, s, e))
}

// ── Writes ───────────────────────────────────────────────────────────────────

const MAX_PATCH_OPS: usize = 100;
const MAX_PATCH_DEPTH: usize = 32;

#[derive(Clone, Debug, PartialEq)]
enum PatchComponent {
    Key(String),
    Index(usize),
}

fn patch_error(message: impl Into<String>) -> (String, String) {
    super::resource_error("INVALID_PATCH", message)
}

fn patch_path(value: Option<&Value>) -> Result<Vec<PatchComponent>, (String, String)> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| patch_error("op.path must be an array"))?;
    if values.len() > MAX_PATCH_DEPTH {
        return Err(patch_error("op.path is too deep"));
    }
    values
        .iter()
        .map(|part| {
            if let Some(key) = part.as_str() {
                if key.is_empty() {
                    Err(patch_error("path keys must not be empty"))
                } else {
                    Ok(PatchComponent::Key(key.to_string()))
                }
            } else if let Some(index) = part.as_u64().and_then(|n| usize::try_from(n).ok()) {
                Ok(PatchComponent::Index(index))
            } else {
                Err(patch_error(
                    "path components must be strings or non-negative integers",
                ))
            }
        })
        .collect()
}

fn yaml_route(path: &[PatchComponent]) -> Route<'static> {
    Route::from(
        path.iter()
            .map(|part| match part {
                PatchComponent::Key(key) => YamlComponent::from(key.clone()),
                PatchComponent::Index(index) => YamlComponent::from(*index),
            })
            .collect::<Vec<_>>(),
    )
}

fn yaml_fragment(value: &Value) -> Result<String, (String, String)> {
    serde_yaml::to_string(value)
        .map(|text| text.trim_end_matches('\n').to_string())
        .map_err(|error| patch_error(format!("value cannot be encoded as YAML: {error}")))
}

fn indent_fragment(fragment: &str, indent: usize) -> String {
    let padding = " ".repeat(indent);
    fragment
        .split('\n')
        .enumerate()
        .map(|(index, line)| {
            if index == 0 {
                line.to_string()
            } else {
                format!("{padding}{line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn yaml_sequence_item(value: &Value, indent: usize) -> Result<String, (String, String)> {
    let fragment = yaml_fragment(value)?;
    let mut lines = fragment.lines();
    let first = lines.next().unwrap_or("null");
    let padding = " ".repeat(indent);
    let continuation = " ".repeat(indent + 2);
    let mut result = format!("{padding}- {first}\n");
    for line in lines {
        result.push_str(&continuation);
        result.push_str(line);
        result.push('\n');
    }
    Ok(result)
}

fn line_indent(source: &str, byte: usize) -> usize {
    let start = source[..byte].rfind('\n').map_or(0, |index| index + 1);
    source[start..byte]
        .chars()
        .take_while(|ch| *ch == ' ')
        .count()
}

fn yaml_insert_raw(
    source: &mut String,
    path: &[PatchComponent],
    index: usize,
    raw_item: Option<String>,
    value: Option<&Value>,
) -> Result<(), (String, String)> {
    let doc = YamlDocument::new(source.clone()).map_err(|error| patch_error(error.to_string()))?;
    if doc.has_anchors() {
        return Err(patch_error(
            "YAML anchors and aliases cannot be patched safely",
        ));
    }
    let route = yaml_route(path);
    let feature = doc
        .query_exact(&route)
        .map_err(|error| patch_error(error.to_string()))?
        .ok_or_else(|| patch_error("sequence path has no value"))?;
    let parsed = parse_structured("value.yaml", source)
        .ok_or_else(|| patch_error("file is not valid YAML"))?;
    let sequence = value_at_path(&parsed, path)?
        .as_array()
        .ok_or_else(|| patch_error("insert target must be a sequence"))?;
    if index > sequence.len() {
        return Err(patch_error("insert index exceeds sequence length"));
    }

    match feature.kind() {
        FeatureKind::BlockSequence if !sequence.is_empty() => {
            let (offset, indent) = if index < sequence.len() {
                let child = yaml_route(&[path, &[PatchComponent::Index(index)]].concat());
                let child_indent = doc
                    .query_exact(&child)
                    .map_err(|error| patch_error(error.to_string()))?
                    .map(|item| item.location.point_span.0 .1.saturating_sub(2))
                    .ok_or_else(|| patch_error("sequence item has no value"))?;
                let span = doc
                    .removal_span(&child)
                    .map_err(|error| patch_error(error.to_string()))?;
                (span.start, child_indent)
            } else {
                let child =
                    yaml_route(&[path, &[PatchComponent::Index(sequence.len() - 1)]].concat());
                let child_indent = doc
                    .query_exact(&child)
                    .map_err(|error| patch_error(error.to_string()))?
                    .map(|item| item.location.point_span.0 .1.saturating_sub(2))
                    .ok_or_else(|| patch_error("sequence item has no value"))?;
                let span = doc
                    .removal_span(&child)
                    .map_err(|error| patch_error(error.to_string()))?;
                (span.end, child_indent)
            };
            let item = match raw_item {
                Some(item) => item,
                None => yaml_sequence_item(
                    value.ok_or_else(|| patch_error("insert value is required"))?,
                    indent,
                )?,
            };
            source.insert_str(offset, &item);
            Ok(())
        }
        FeatureKind::FlowSequence if sequence.is_empty() => {
            let indent = if path.is_empty() {
                0
            } else {
                line_indent(source, feature.location.byte_span.0) + 2
            };
            let item = match raw_item {
                Some(item) => item,
                None => yaml_sequence_item(
                    value.ok_or_else(|| patch_error("insert value is required"))?,
                    indent,
                )?,
            };
            let replacement = if path.is_empty() {
                item
            } else {
                format!("\n{item}")
            };
            source.replace_range(
                feature.location.byte_span.0..feature.location.byte_span.1,
                replacement.trim_end_matches('\n'),
            );
            Ok(())
        }
        FeatureKind::FlowSequence => Err(patch_error(
            "inserting into a flow-style YAML sequence is unsupported",
        )),
        _ => Err(patch_error("insert target must be a sequence")),
    }
}

fn value_at_path<'a>(
    root: &'a Value,
    path: &[PatchComponent],
) -> Result<&'a Value, (String, String)> {
    let mut cursor = root;
    for part in path {
        cursor = match part {
            PatchComponent::Key(key) => cursor
                .as_object()
                .and_then(|map| map.get(key))
                .ok_or_else(|| patch_error(format!("missing mapping key `{key}`")))?,
            PatchComponent::Index(index) => cursor
                .as_array()
                .and_then(|items| items.get(*index))
                .ok_or_else(|| {
                patch_error(format!("sequence index {index} is out of bounds"))
            })?,
        };
    }
    Ok(cursor)
}

fn value_at_path_mut<'a>(
    root: &'a mut Value,
    path: &[PatchComponent],
) -> Result<&'a mut Value, (String, String)> {
    let mut cursor = root;
    for part in path {
        cursor = match part {
            PatchComponent::Key(key) => cursor
                .as_object_mut()
                .and_then(|map| map.get_mut(key))
                .ok_or_else(|| patch_error(format!("missing mapping key `{key}`")))?,
            PatchComponent::Index(index) => cursor
                .as_array_mut()
                .and_then(|items| items.get_mut(*index))
                .ok_or_else(|| patch_error(format!("sequence index {index} is out of bounds")))?,
        };
    }
    Ok(cursor)
}

fn apply_value_op(root: &mut Value, op: &Value) -> Result<(), (String, String)> {
    let kind = op
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| patch_error("op.op is required"))?;
    let path = patch_path(op.get("path"))?;
    match kind {
        "set" => {
            let next = op
                .get("value")
                .cloned()
                .ok_or_else(|| patch_error("set.value is required"))?;
            if path.is_empty() {
                *root = next;
            } else {
                let (parent_path, last) = path.split_at(path.len() - 1);
                let parent = value_at_path_mut(root, parent_path)?;
                match &last[0] {
                    PatchComponent::Key(key) => {
                        parent
                            .as_object_mut()
                            .ok_or_else(|| patch_error("set parent must be a mapping"))?
                            .insert(key.clone(), next);
                    }
                    PatchComponent::Index(index) => {
                        let items = parent
                            .as_array_mut()
                            .ok_or_else(|| patch_error("set parent must be a sequence"))?;
                        let slot = items
                            .get_mut(*index)
                            .ok_or_else(|| patch_error("set index is out of bounds"))?;
                        *slot = next;
                    }
                }
            }
        }
        "insert" => {
            let index = op
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| patch_error("insert.index is required"))?;
            let next = op
                .get("value")
                .cloned()
                .ok_or_else(|| patch_error("insert.value is required"))?;
            let items = value_at_path_mut(root, &path)?
                .as_array_mut()
                .ok_or_else(|| patch_error("insert target must be a sequence"))?;
            if index > items.len() {
                return Err(patch_error("insert index exceeds sequence length"));
            }
            items.insert(index, next);
        }
        "remove" => {
            if path.is_empty() {
                return Err(patch_error("cannot remove the document root"));
            }
            let (parent_path, last) = path.split_at(path.len() - 1);
            let parent = value_at_path_mut(root, parent_path)?;
            match &last[0] {
                PatchComponent::Key(key) => {
                    if parent
                        .as_object_mut()
                        .and_then(|map| map.remove(key))
                        .is_none()
                    {
                        return Err(patch_error("remove key does not exist"));
                    }
                }
                PatchComponent::Index(index) => {
                    let items = parent
                        .as_array_mut()
                        .ok_or_else(|| patch_error("remove parent must be a sequence"))?;
                    if *index >= items.len() {
                        return Err(patch_error("remove index is out of bounds"));
                    }
                    items.remove(*index);
                }
            }
        }
        "move" => {
            let from = op
                .get("from")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| patch_error("move.from is required"))?;
            let to = op
                .get("to")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| patch_error("move.to is required"))?;
            let items = value_at_path_mut(root, &path)?
                .as_array_mut()
                .ok_or_else(|| patch_error("move target must be a sequence"))?;
            if from >= items.len() || to >= items.len() {
                return Err(patch_error("move index is out of bounds"));
            }
            if from != to {
                let item = items.remove(from);
                items.insert(to, item);
            }
        }
        _ => return Err(patch_error(format!("unsupported patch op `{kind}`"))),
    }
    Ok(())
}

fn apply_yaml_op(source: &mut String, op: &Value) -> Result<(), (String, String)> {
    let kind = op
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| patch_error("op.op is required"))?;
    let path = patch_path(op.get("path"))?;
    let doc = YamlDocument::new(source.clone()).map_err(|error| patch_error(error.to_string()))?;
    if doc.has_anchors() {
        return Err(patch_error(
            "YAML anchors and aliases cannot be patched safely",
        ));
    }
    match kind {
        "set" => {
            let next = op
                .get("value")
                .ok_or_else(|| patch_error("set.value is required"))?;
            let route = yaml_route(&path);
            match doc.query_exact(&route) {
                Ok(Some(feature)) => {
                    let replacement =
                        indent_fragment(&yaml_fragment(next)?, feature.location.point_span.0 .1);
                    source.replace_range(
                        feature.location.byte_span.0..feature.location.byte_span.1,
                        &replacement,
                    );
                }
                Ok(None) | Err(_) => {
                    let Some(PatchComponent::Key(key)) = path.last() else {
                        return Err(patch_error("set target does not exist"));
                    };
                    let parent_path = &path[..path.len() - 1];
                    let parent = doc
                        .query_exact(&yaml_route(parent_path))
                        .map_err(|error| patch_error(error.to_string()))?
                        .ok_or_else(|| patch_error("set parent has no value"))?;
                    if parent.kind() != FeatureKind::BlockMapping {
                        return Err(patch_error("new keys require a block-style mapping"));
                    }
                    let mut mapping = serde_json::Map::new();
                    mapping.insert(key.clone(), next.clone());
                    let indent = parent.location.point_span.0 .1;
                    let addition =
                        indent_fragment(&yaml_fragment(&Value::Object(mapping))?, indent);
                    let offset = parent.location.byte_span.1;
                    let prefix = if source[..offset].ends_with('\n') {
                        ""
                    } else {
                        "\n"
                    };
                    source.insert_str(offset, &format!("{prefix}{addition}"));
                }
            }
        }
        "insert" => {
            let index = op
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| patch_error("insert.index is required"))?;
            yaml_insert_raw(source, &path, index, None, op.get("value"))?;
        }
        "remove" => {
            let span = doc
                .removal_span(&yaml_route(&path))
                .map_err(|error| patch_error(error.to_string()))?;
            source.replace_range(span, "");
        }
        "move" => {
            let from = op
                .get("from")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| patch_error("move.from is required"))?;
            let to = op
                .get("to")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| patch_error("move.to is required"))?;
            let parsed = parse_structured("value.yaml", source)
                .ok_or_else(|| patch_error("file is not valid YAML"))?;
            let length = value_at_path(&parsed, &path)?
                .as_array()
                .ok_or_else(|| patch_error("move target must be a sequence"))?
                .len();
            if from >= length || to >= length {
                return Err(patch_error("move index is out of bounds"));
            }
            if from != to {
                let item_path = [path.as_slice(), &[PatchComponent::Index(from)]].concat();
                let span = doc
                    .removal_span(&yaml_route(&item_path))
                    .map_err(|error| patch_error(error.to_string()))?;
                let raw = source[span.clone()].to_string();
                source.replace_range(span, "");
                yaml_insert_raw(source, &path, to, Some(raw), None)?;
            }
        }
        _ => return Err(patch_error(format!("unsupported patch op `{kind}`"))),
    }
    Ok(())
}

fn apply_structured_ops(
    path: &str,
    content: &str,
    ops: &[Value],
) -> Result<String, (String, String)> {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "json" => {
            let mut value: Value = serde_json::from_str(content)
                .map_err(|error| patch_error(format!("invalid JSON: {error}")))?;
            for op in ops {
                apply_value_op(&mut value, op)?;
            }
            serde_json::to_string_pretty(&value)
                .map(|mut text| {
                    text.push('\n');
                    text
                })
                .map_err(|error| patch_error(error.to_string()))
        }
        "yaml" | "yml" => {
            let mut text = content.to_string();
            for op in ops {
                apply_yaml_op(&mut text, op)?;
            }
            serde_yaml::from_str::<Value>(&text)
                .map_err(|error| patch_error(format!("patch produced invalid YAML: {error}")))?;
            Ok(text)
        }
        _ => Err(patch_error(
            "fs.patch supports only .json, .yaml, and .yml files",
        )),
    }
}

/// `fs.patch` — atomically apply structured edits while preserving YAML formatting.
pub async fn handle_patch(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let (channel_id, path) = extract_channel_path(params, false)?;
    check_fs_write(db, principal, channel_id).await?;
    let expected = params
        .get("if_version")
        .and_then(Value::as_i64)
        .ok_or_else(|| patch_error("if_version is required"))?;
    let ops = params
        .get("ops")
        .and_then(Value::as_array)
        .ok_or_else(|| patch_error("ops must be an array"))?;
    if ops.is_empty() || ops.len() > MAX_PATCH_OPS {
        return Err(patch_error("ops must contain 1..=100 operations"));
    }

    let mut tx = db
        .begin()
        .await
        .map_err(super::db_err("fs.patch: begin tx"))?;
    let row = sqlx::query("SELECT content, version, is_dir FROM context_files WHERE channel_id = $1 AND path = $2 FOR UPDATE")
        .bind(channel_id.to_string()).bind(&path).fetch_optional(&mut *tx).await
        .map_err(super::db_err("fs.patch: select file"))?.ok_or_else(|| super::not_found("file"))?;
    if row.try_get::<bool, _>("is_dir").unwrap_or(false) {
        return Err(patch_error("path is a directory"));
    }
    let current = row.try_get::<i64, _>("version").unwrap_or(0);
    if current != expected {
        return Err(version_conflict(current));
    }
    let content = row.try_get::<String, _>("content").unwrap_or_default();
    let next = apply_structured_ops(&path, &content, ops)?;
    enforce_file_size(&next)?;
    let version = sqlx::query("UPDATE context_files SET content = $3, version = version + 1, updated_at = NOW() WHERE channel_id = $1 AND path = $2 RETURNING version")
        .bind(channel_id.to_string()).bind(&path).bind(next).fetch_one(&mut *tx).await
        .map_err(super::db_err("fs.patch: update file"))?.try_get::<i64, _>("version").unwrap_or(current + 1);
    let seq = insert_operation(
        &mut tx,
        channel_id,
        "fs.patch",
        principal,
        &path,
        json!({"path": path, "version": version, "ops": ops}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(super::db_err("fs.patch: commit tx"))?;
    Ok(json!({"channel_id": channel_id, "path": path, "version": version, "channel_seq": seq}))
}

/// `fs.write` — create or overwrite a file. `if_version=0` means create-only.
pub async fn handle_write(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let (channel_id, path) = extract_channel_path(params, false)?;
    check_fs_write(db, principal, channel_id).await?;
    let content = params.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let is_dir = params
        .get("is_dir")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let if_version = params.get("if_version").and_then(|v| v.as_i64());
    enforce_file_size(content)?;

    let mut tx = db
        .begin()
        .await
        .map_err(super::db_err("fs.write: begin tx"))?;
    let existing = sqlx::query(
        "SELECT version
         FROM context_files
         WHERE channel_id = $1 AND path = $2
         FOR UPDATE",
    )
    .bind(channel_id.to_string())
    .bind(&path)
    .fetch_optional(&mut *tx)
    .await
    .map_err(super::db_err(
        "fs.write: select existing version (FOR UPDATE)",
    ))?;

    let version = if let Some(row) = existing {
        let current = row.try_get::<i64, _>("version").unwrap_or(0);
        if let Some(expected) = if_version {
            if expected != current {
                return Err(version_conflict(current));
            }
        }
        sqlx::query(
            "UPDATE context_files
             SET content = $3,
                 is_dir = $4,
                 version = version + 1,
                 updated_at = NOW()
             WHERE channel_id = $1 AND path = $2
             RETURNING version",
        )
        .bind(channel_id.to_string())
        .bind(&path)
        .bind(content)
        .bind(is_dir)
        .fetch_one(&mut *tx)
        .await
        .map_err(super::db_err("fs.write: update existing file"))?
        .try_get::<i64, _>("version")
        .unwrap_or(current + 1)
    } else {
        if let Some(expected) = if_version {
            if expected != 0 {
                return Err(version_conflict(0));
            }
        }
        enforce_channel_file_count(&mut tx, channel_id).await?;
        sqlx::query(
            "INSERT INTO context_files (
                file_id, channel_id, path, content, version, is_dir, created_by, creator_type
             ) VALUES ($1, $2, $3, $4, 1, $5, $6, $7)
             RETURNING version",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(channel_id.to_string())
        .bind(&path)
        .bind(content)
        .bind(is_dir)
        .bind(principal.principal_id.to_string())
        .bind(principal.member_type())
        .fetch_one(&mut *tx)
        .await
        .map_err(super::db_err("fs.write: insert new file"))?
        .try_get::<i64, _>("version")
        .unwrap_or(1)
    };

    let seq = insert_operation(
        &mut tx,
        channel_id,
        "fs.write",
        principal,
        &path,
        json!({"path": path, "version": version, "is_dir": is_dir}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(super::db_err("fs.write: commit tx"))?;

    Ok(json!({
        "channel_id": channel_id,
        "path": path,
        "version": version,
        "channel_seq": seq,
    }))
}

/// `fs.edit` — replace exactly one string occurrence.
pub async fn handle_edit(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let (channel_id, path) = extract_channel_path(params, false)?;
    check_fs_write(db, principal, channel_id).await?;
    let old = params
        .get("old_string")
        .and_then(|v| v.as_str())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "old_string required"))?;
    if old.is_empty() {
        return Err(super::resource_error(
            "INVALID_PARAMS",
            "old_string can not be empty",
        ));
    }
    let new = params
        .get("new_string")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let if_version = params.get("if_version").and_then(|v| v.as_i64());

    let mut tx = db
        .begin()
        .await
        .map_err(super::db_err("fs.edit: begin tx"))?;
    let row = sqlx::query(
        "SELECT content, version, is_dir
         FROM context_files
         WHERE channel_id = $1 AND path = $2
         FOR UPDATE",
    )
    .bind(channel_id.to_string())
    .bind(&path)
    .fetch_optional(&mut *tx)
    .await
    .map_err(super::db_err("fs.edit: select file (FOR UPDATE)"))?
    .ok_or_else(|| super::not_found("file"))?;
    if row.try_get::<bool, _>("is_dir").unwrap_or(false) {
        return Err(super::resource_error(
            "INVALID_PARAMS",
            "path is a directory",
        ));
    }

    let current_version = row.try_get::<i64, _>("version").unwrap_or(0);
    if let Some(expected) = if_version {
        if expected != current_version {
            return Err(version_conflict(current_version));
        }
    }
    let content = row.try_get::<String, _>("content").unwrap_or_default();
    let occurrences = content.matches(old).count();
    if occurrences != 1 {
        return Err(super::resource_error(
            "EDIT_CONFLICT",
            format!("old_string matched {occurrences} times"),
        ));
    }
    let updated = content.replacen(old, new, 1);
    let version = update_content(&mut tx, channel_id, &path, &updated).await?;
    let seq = insert_operation(
        &mut tx,
        channel_id,
        "fs.edit",
        principal,
        &path,
        json!({"path": path, "version": version}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(super::db_err("fs.edit: commit tx"))?;

    Ok(json!({
        "channel_id": channel_id,
        "path": path,
        "version": version,
        "channel_seq": seq,
    }))
}

/// `fs.append` — append to a file, creating it if missing.
pub async fn handle_append(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let (channel_id, path) = extract_channel_path(params, false)?;
    check_fs_write(db, principal, channel_id).await?;
    let append = params.get("content").and_then(|v| v.as_str()).unwrap_or("");

    let mut tx = db
        .begin()
        .await
        .map_err(super::db_err("fs.append: begin tx"))?;
    let existing = sqlx::query(
        "SELECT content, version, is_dir
         FROM context_files
         WHERE channel_id = $1 AND path = $2
         FOR UPDATE",
    )
    .bind(channel_id.to_string())
    .bind(&path)
    .fetch_optional(&mut *tx)
    .await
    .map_err(super::db_err("fs.append: select existing (FOR UPDATE)"))?;

    let version = if let Some(row) = existing {
        if row.try_get::<bool, _>("is_dir").unwrap_or(false) {
            return Err(super::resource_error(
                "INVALID_PARAMS",
                "path is a directory",
            ));
        }
        let mut content = row.try_get::<String, _>("content").unwrap_or_default();
        content.push_str(append);
        update_content(&mut tx, channel_id, &path, &content).await?
    } else {
        enforce_channel_file_count(&mut tx, channel_id).await?;
        enforce_file_size(append)?;
        sqlx::query(
            "INSERT INTO context_files (
                file_id, channel_id, path, content, version, is_dir, created_by, creator_type
             ) VALUES ($1, $2, $3, $4, 1, FALSE, $5, $6)
             RETURNING version",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(channel_id.to_string())
        .bind(&path)
        .bind(append)
        .bind(principal.principal_id.to_string())
        .bind(principal.member_type())
        .fetch_one(&mut *tx)
        .await
        .map_err(super::db_err("fs.append: insert new file"))?
        .try_get::<i64, _>("version")
        .unwrap_or(1)
    };

    let seq = insert_operation(
        &mut tx,
        channel_id,
        "fs.append",
        principal,
        &path,
        json!({"path": path, "version": version, "appended_bytes": append.len()}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(super::db_err("fs.append: commit tx"))?;

    Ok(json!({
        "channel_id": channel_id,
        "path": path,
        "version": version,
        "channel_seq": seq,
    }))
}

/// `fs.rm` — remove a file or, with `recursive=true`, a subtree.
pub async fn handle_rm(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let (channel_id, path) = extract_channel_path(params, false)?;
    check_fs_write(db, principal, channel_id).await?;
    let recursive = params
        .get("recursive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut tx = db.begin().await.map_err(super::db_err("fs.rm: begin tx"))?;
    let rows = sqlx::query(
        "SELECT path
         FROM context_files
         WHERE channel_id = $1
           AND (path = $2 OR left(path, char_length($2) + 1) = $2 || '/')
         FOR UPDATE",
    )
    .bind(channel_id.to_string())
    .bind(&path)
    .fetch_all(&mut *tx)
    .await
    .map_err(super::db_err("fs.rm: select subtree (FOR UPDATE)"))?;
    if rows.is_empty() {
        return Err(super::not_found("file"));
    }
    if rows.len() > 1 && !recursive {
        return Err(super::resource_error(
            "DIRECTORY_NOT_EMPTY",
            "path has descendants; pass recursive=true",
        ));
    }

    let deleted = sqlx::query(
        "DELETE FROM context_files
         WHERE channel_id = $1
           AND (path = $2 OR left(path, char_length($2) + 1) = $2 || '/')",
    )
    .bind(channel_id.to_string())
    .bind(&path)
    .execute(&mut *tx)
    .await
    .map_err(super::db_err("fs.rm: delete subtree"))?
    .rows_affected();
    let seq = insert_operation(
        &mut tx,
        channel_id,
        "fs.rm",
        principal,
        &path,
        json!({"path": path, "recursive": recursive, "deleted": deleted}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(super::db_err("fs.rm: commit tx"))?;

    Ok(json!({
        "channel_id": channel_id,
        "path": path,
        "deleted": deleted,
        "channel_seq": seq,
    }))
}

/// `fs.mv` — move/rename one node and all descendants.
pub async fn handle_mv(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id = extract_channel_id(params)?;
    check_fs_write(db, principal, channel_id).await?;
    let from = normalize_path(
        params.get("from").and_then(|v| v.as_str()).unwrap_or(""),
        false,
    )?;
    let to = normalize_path(
        params.get("to").and_then(|v| v.as_str()).unwrap_or(""),
        false,
    )?;
    if from == to {
        return Ok(json!({
            "channel_id": channel_id,
            "from": from,
            "to": to,
            "moved": 0,
            "channel_seq": null,
        }));
    }
    if to.starts_with(&format!("{from}/")) {
        return Err(super::resource_error(
            "INVALID_PARAMS",
            "can not move a path into its own subtree",
        ));
    }

    let mut tx = db.begin().await.map_err(super::db_err("fs.mv: begin tx"))?;
    let source_count: i64 = sqlx::query(
        "SELECT COUNT(*) AS count
         FROM context_files
         WHERE channel_id = $1
           AND (path = $2 OR left(path, char_length($2) + 1) = $2 || '/')",
    )
    .bind(channel_id.to_string())
    .bind(&from)
    .fetch_one(&mut *tx)
    .await
    .map_err(super::db_err("fs.mv: count source subtree"))?
    .try_get("count")
    .unwrap_or(0);
    if source_count == 0 {
        return Err(super::not_found("file"));
    }

    let target_count: i64 = sqlx::query(
        "SELECT COUNT(*) AS count
         FROM context_files
         WHERE channel_id = $1
           AND (path = $2 OR left(path, char_length($2) + 1) = $2 || '/')",
    )
    .bind(channel_id.to_string())
    .bind(&to)
    .fetch_one(&mut *tx)
    .await
    .map_err(super::db_err("fs.mv: count target subtree"))?
    .try_get("count")
    .unwrap_or(0);
    if target_count > 0 {
        return Err(super::resource_error(
            "PATH_CONFLICT",
            "target path already exists",
        ));
    }

    let moved = sqlx::query(
        "UPDATE context_files
         SET path = CASE
                 WHEN path = $2 THEN $3
                 ELSE $3 || substring(path from char_length($2) + 1)
             END,
             version = version + 1,
             updated_at = NOW()
         WHERE channel_id = $1
           AND (path = $2 OR left(path, char_length($2) + 1) = $2 || '/')",
    )
    .bind(channel_id.to_string())
    .bind(&from)
    .bind(&to)
    .execute(&mut *tx)
    .await
    .map_err(super::db_err("fs.mv: update paths"))?
    .rows_affected();
    let seq = insert_operation(
        &mut tx,
        channel_id,
        "fs.mv",
        principal,
        &from,
        json!({"from": from, "to": to, "moved": moved}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(super::db_err("fs.mv: commit tx"))?;

    Ok(json!({
        "channel_id": channel_id,
        "from": from,
        "to": to,
        "moved": moved,
        "channel_seq": seq,
    }))
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async fn check_fs_write(
    db: &PgPool,
    principal: &Principal,
    channel_id: Uuid,
) -> Result<(), (String, String)> {
    authorize_channel_write(db, principal, channel_id)
        .await
        .map(|_| ())
}

/// 单文件内容硬上限（字节）。`context_files.content` 是 TEXT 行内存储，写入还会
/// 全量经 WS 广播给每个订阅者——无上限即存储耗尽 / 网关 OOM 的口子（user 桥已
/// 让浏览器能写）。对 bot 与 user 路径同等生效（安全上限，非授权）。
const MAX_FILE_BYTES: usize = 256 * 1024;

/// 每频道文件数上限。配合 `MAX_FILE_BYTES` 给频道工作区一个有界总量
/// （≤ MAX_CHANNEL_FILES × MAX_FILE_BYTES）。
const MAX_CHANNEL_FILES: i64 = 1024;

/// 写入前校验单文件内容不超过 `MAX_FILE_BYTES`。所有写路径（write/edit/append 的
/// 最终内容）都必须过这道关，不可按 verb 绕过。
fn enforce_file_size(content: &str) -> Result<(), (String, String)> {
    if content.len() > MAX_FILE_BYTES {
        return Err(super::resource_error(
            "CONTENT_TOO_LARGE",
            format!(
                "file content {} bytes exceeds limit {MAX_FILE_BYTES}",
                content.len()
            ),
        ));
    }
    Ok(())
}

/// 新建文件前校验频道文件数未达上限（仅 INSERT 路径需要）。
async fn enforce_channel_file_count(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    channel_id: Uuid,
) -> Result<(), (String, String)> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM context_files WHERE channel_id = $1")
        .bind(channel_id.to_string())
        .fetch_one(&mut **tx)
        .await
        .map_err(super::db_err("enforce_channel_file_count: count files"))?;
    if count >= MAX_CHANNEL_FILES {
        return Err(super::resource_error(
            "CHANNEL_QUOTA_EXCEEDED",
            format!("channel already has {count} files (limit {MAX_CHANNEL_FILES})"),
        ));
    }
    Ok(())
}

async fn update_content(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    channel_id: Uuid,
    path: &str,
    content: &str,
) -> Result<i64, (String, String)> {
    enforce_file_size(content)?;
    sqlx::query(
        "UPDATE context_files
         SET content = $3,
             version = version + 1,
             updated_at = NOW()
         WHERE channel_id = $1 AND path = $2
         RETURNING version",
    )
    .bind(channel_id.to_string())
    .bind(path)
    .bind(content)
    .fetch_one(&mut **tx)
    .await
    .map_err(super::db_err("update_content: update file content"))?
    .try_get::<i64, _>("version")
    .map_err(super::db_err("update_content: read version column"))
}

/// Append ONE `channel_operations` audit row for an out-of-band write (e.g. a human
/// editing a bot's remote workspace through the browser), in its own transaction,
/// reusing [`insert_operation`] + the shared `channel_seq`. Not a `fs.*` mutation —
/// there is no `context_files` row to touch; this is purely the bookkeeping tail so
/// the write shows up on the channel activity feed. Returns the allocated `channel_seq`.
pub async fn record_operation(
    db: &PgPool,
    channel_id: Uuid,
    op_type: &str,
    principal: Principal,
    target_ref: &str,
    payload: Value,
) -> Result<i64, (String, String)> {
    let mut tx = db
        .begin()
        .await
        .map_err(super::db_err("record_operation: begin tx"))?;
    let seq = insert_operation(
        &mut tx, channel_id, op_type, &principal, target_ref, payload,
    )
    .await?;
    tx.commit()
        .await
        .map_err(super::db_err("record_operation: commit tx"))?;
    Ok(seq)
}

async fn insert_operation(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    channel_id: Uuid,
    op_type: &str,
    principal: &Principal,
    target_ref: &str,
    payload: Value,
) -> Result<i64, (String, String)> {
    let seq = channel_seq::allocate(tx, channel_id)
        .await
        .map_err(super::db_err("insert_operation: allocate channel_seq"))?;
    sqlx::query(
        "INSERT INTO channel_operations (
            id, channel_id, channel_seq, op_type, actor_type, actor_id, target_ref, payload
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(channel_id.to_string())
    .bind(seq)
    .bind(op_type)
    .bind(principal.member_type())
    .bind(principal.principal_id.to_string())
    .bind(target_ref)
    .bind(payload)
    .execute(&mut **tx)
    .await
    .map_err(super::db_err("insert_operation: insert channel_operation"))?;

    Ok(seq)
}

fn extract_channel_path(
    params: &Value,
    allow_empty: bool,
) -> Result<(Uuid, String), (String, String)> {
    let channel_id = extract_channel_id(params)?;
    let path = normalize_path(
        params.get("path").and_then(|v| v.as_str()).unwrap_or(""),
        allow_empty,
    )?;
    Ok((channel_id, path))
}

fn extract_channel_id(params: &Value) -> Result<Uuid, (String, String)> {
    params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("BAD_REQUEST", "missing channel_id"))
}

/// A bare uuid as the whole path is almost certainly a misused attachment file_id — the
/// agent confusing the read-only Inbox (channel.files, by file_id) with the editable
/// Desk/workspace (fs.*, by path). Reject it with a pointer, turning a silent miss into a
/// precise, correctable error.
fn looks_like_file_id(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn normalize_path(raw: &str, allow_empty: bool) -> Result<String, (String, String)> {
    let path = raw.trim().trim_matches('/').to_string();
    if path.is_empty() {
        if allow_empty {
            return Ok(path);
        }
        return Err(super::resource_error("BAD_REQUEST", "missing path"));
    }
    if path.len() > 1024 {
        return Err(super::resource_error("BAD_REQUEST", "path is too long"));
    }
    if path.chars().any(char::is_control) {
        return Err(super::resource_error(
            "BAD_REQUEST",
            "path contains control characters",
        ));
    }
    if path
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(super::resource_error("BAD_REQUEST", "invalid path"));
    }
    if looks_like_file_id(&path) {
        return Err(super::resource_error(
            "E_LOOKS_LIKE_FILE_ID",
            "this looks like an attachment file_id, not a workspace path — chat attachments \
             are read-only; read them with inbox_open (channel.files.read), they are not \
             editable workspace files",
        ));
    }
    Ok(path)
}

fn version_conflict(current: i64) -> (String, String) {
    super::resource_error(
        "VERSION_CONFLICT",
        format!("version conflict; current_version={current}"),
    )
}

#[cfg(test)]
mod tests {
    use super::{apply_structured_ops, normalize_path, parse_structured, slice_lines};
    use serde_json::json;

    #[test]
    fn workspace_path_rejects_control_characters_and_excessive_length() {
        assert!(normalize_path("reports/weekly\0.md", false).is_err());
        assert!(normalize_path(&"a".repeat(1025), false).is_err());
        assert_eq!(
            normalize_path("reports/weekly.md", false).unwrap(),
            "reports/weekly.md"
        );
    }

    #[test]
    fn no_range_returns_none() {
        assert!(slice_lines("a\nb\nc", None, None).is_none());
    }

    #[test]
    fn inclusive_window() {
        let (text, s, e) = slice_lines("l1\nl2\nl3\nl4", Some(2), Some(3)).unwrap();
        assert_eq!(text, "l2\nl3");
        assert_eq!((s, e), (2, 3));
    }

    #[test]
    fn open_ended_and_open_start() {
        assert_eq!(
            slice_lines("l1\nl2\nl3", Some(2), None).unwrap().0,
            "l2\nl3"
        );
        assert_eq!(
            slice_lines("l1\nl2\nl3", None, Some(2)).unwrap().0,
            "l1\nl2"
        );
    }

    #[test]
    fn clamps_out_of_bounds_and_reordered() {
        // end past EOF clamps to last line
        let (text, s, e) = slice_lines("l1\nl2\nl3", Some(2), Some(99)).unwrap();
        assert_eq!(text, "l2\nl3");
        assert_eq!((s, e), (2, 3));
        // start past EOF clamps to last line; end < start clamps up to start
        let (text, s, e) = slice_lines("l1\nl2\nl3", Some(99), Some(1)).unwrap();
        assert_eq!(text, "l3");
        assert_eq!((s, e), (3, 3));
    }

    #[test]
    fn single_line_file() {
        let (text, s, e) = slice_lines("only", Some(1), Some(1)).unwrap();
        assert_eq!(text, "only");
        assert_eq!((s, e), (1, 1));
    }

    #[test]
    fn parse_structured_yaml_with_comments_and_11_booleans() {
        let y = "# header\ntasks:\n  - title: ship\n    done: no   # 1.1 would say false\n";
        let v = parse_structured("board.yaml", y).expect("yaml parses");
        // Comments are invisible to data; the 1.1 boolean literal stays a STRING (1.2).
        assert_eq!(v["tasks"][0]["done"], serde_json::json!("no"));
        assert_eq!(v["tasks"][0]["title"], serde_json::json!("ship"));
    }

    #[test]
    fn parse_structured_scopes_and_failures() {
        assert!(parse_structured("a.json", r#"{"k":1}"#).is_some());
        assert!(parse_structured("a.yml", "k: 1").is_some());
        // Prose is not a board; garbage must not error a read.
        assert!(parse_structured("notes.md", "# hi").is_none());
        assert!(parse_structured("bad.yaml", "a: [unclosed").is_none());
        assert!(parse_structured("noext", "k: 1").is_none());
    }

    #[test]
    fn json_patch_supports_all_operations() {
        let input = r#"{"rows":[{"name":"a","done":false},{"name":"b","done":false}]}"#;
        let output = apply_structured_ops(
            "board.json",
            input,
            &[
                json!({"op":"set","path":["rows",0,"done"],"value":true}),
                json!({"op":"insert","path":["rows"],"index":1,"value":{"name":"x","done":false}}),
                json!({"op":"move","path":["rows"],"from":2,"to":0}),
                json!({"op":"remove","path":["rows",1]}),
            ],
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(
            value["rows"],
            json!([
                {"name":"b","done":false},
                {"name":"x","done":false}
            ])
        );
    }

    #[test]
    fn yaml_patch_preserves_comments_and_format() {
        let input = "# board\nrows:\n  - name: a # keep\n    done: false\n  - name: b\n    done: false\nfooter: yes # untouched\n";
        let ops = [
            json!({"op":"set","path":["rows",0,"done"],"value":true}),
            json!({"op":"insert","path":["rows"],"index":1,"value":{"name":"x","done":false}}),
            json!({"op":"move","path":["rows"],"from":2,"to":0}),
            json!({"op":"remove","path":["rows",1]}),
        ];
        let mut output = input.to_string();
        for op in ops {
            output = apply_structured_ops("board.yaml", &output, std::slice::from_ref(&op))
                .unwrap_or_else(|error| panic!("op {op} failed against:\n{output}\n{error:?}"));
        }
        assert!(output.contains("# board"));
        assert!(output.contains("footer: yes # untouched"));
        let value: serde_json::Value = serde_yaml::from_str(&output).unwrap();
        assert_eq!(
            value["rows"],
            json!([
                {"name":"b","done":false},
                {"name":"x","done":false}
            ])
        );
    }

    #[test]
    fn yaml_patch_rejects_aliases_and_invalid_paths() {
        let aliased = "base: &base\n  done: false\ncopy: *base\n";
        assert!(apply_structured_ops(
            "board.yaml",
            aliased,
            &[json!({"op":"set","path":["base","done"],"value":true})],
        )
        .is_err());
        assert!(apply_structured_ops(
            "board.yaml",
            "rows: []\n",
            &[json!({"op":"remove","path":["rows",0]})],
        )
        .is_err());
    }
}
