use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;

static MARKER: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"\{\{(mention|file|panel):([a-z][a-z0-9_]{0,31})\}\}").unwrap()
});

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Slot {
    pub key: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SuggestedQuestion {
    pub text: String,
    #[serde(default)]
    pub slots: Vec<Slot>,
}

pub fn validate(value: &Value) -> Result<Vec<SuggestedQuestion>, &'static str> {
    let questions: Vec<SuggestedQuestion> = serde_json::from_value(value.clone())
        .map_err(|_| "suggestions must be an array of {text, slots}")?;
    if questions.is_empty() || questions.len() > 3 {
        return Err("provide one to three questions");
    }
    for q in &questions {
        if q.text.trim().is_empty() || q.text.len() > 500 || q.slots.len() > 6 {
            return Err("question or slot limit exceeded");
        }
        let markers: Vec<_> = MARKER.captures_iter(&q.text).collect();
        if markers.len() != q.slots.len() {
            return Err("each slot needs exactly one marker");
        }
        let mut keys = std::collections::HashSet::new();
        for slot in &q.slots {
            if !keys.insert(&slot.key)
                || !markers
                    .iter()
                    .any(|m| m[1] == slot.kind && m[2] == slot.key)
            {
                return Err("slot keys and markers must match");
            }
        }
        if q.text.contains("{{") && q.text.matches("{{").count() != markers.len() {
            return Err("unrecognized slot marker");
        }
    }
    Ok(questions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_slot_marker_identity() {
        assert!(validate(&json!([{"text":"Ask {{mention:who}} about {{panel:where}}", "slots":[{"key":"who","kind":"mention"},{"key":"where","kind":"panel"}]}])).is_ok());
        assert!(validate(
            &json!([{"text":"Ask {{mention:who}}", "slots":[{"key":"who","kind":"file"}]}])
        )
        .is_err());
    }
}
