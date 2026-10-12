//! Shared interactive-resource discovery and validated user-action context.
//! A2UI remains a content format; reads/writes and prompts use existing handlers.
pub use cheers_interactive_core::*;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn embedded_contract_matches() {
        let c: Value = serde_json::from_str(CATALOG).unwrap();
        assert_eq!(c["catalogId"], CATALOG_ID);
        assert!(validate_document(&serde_json::from_str(EXAMPLE).unwrap()).is_ok());
        assert!(validate_document(&contract()["request_example"]).is_ok());
    }

    #[test]
    fn rejects_unknown_binding_and_cycle() {
        let mut d: Value = serde_json::from_str(EXAMPLE).unwrap();
        d["messages"][1]["updateComponents"]["components"][0]["children"] = json!(["root"]);
        assert!(validate_document(&d).is_err());
        assert!(pointer("/__proto__/polluted").is_err());
        assert!(pointer("/bad~2").is_err());
    }

    #[test]
    fn presentation_views_reference_only_validated_active_components() {
        let mut doc: Value = serde_json::from_str(EXAMPLE).unwrap();
        assert!(validate_document(&doc).is_ok());
        doc["views"]["minimal"]["root"] = json!("missing");
        assert!(validate_document(&doc).is_err());
        doc["views"] = json!({"minimal":{"surfaceId":"absent","root":"root"}});
        assert!(validate_document(&doc).is_err());
        doc["views"] = json!({"custom":{"surfaceId":"report","root":"root"}});
        assert!(validate_document(&doc).is_err());
    }

    #[test]
    fn extracts_a2ui_and_tsx_actions() {
        let a2ui_doc = contract()["request_example"].clone();
        let a2ui_actions = extract_a2ui_actions(&a2ui_doc).unwrap();
        assert_eq!(a2ui_actions.len(), 1);
        assert_eq!(a2ui_actions[0].action_id, "report.prepare");
        assert_eq!(a2ui_actions[0].name, "cheers.request");
        assert_eq!(
            a2ui_actions[0].bot_id,
            Some("00000000-0000-0000-0000-000000000001".into())
        );

        let tsx_source = tsx_request_example("11111111-2222-3333-4444-555555555555");
        let tsx_actions = extract_tsx_actions(&tsx_source).unwrap();
        assert_eq!(tsx_actions.len(), 1);
        assert_eq!(tsx_actions[0].action_id, "report.prepare");
        assert_eq!(
            tsx_actions[0].bot_id,
            Some("11111111-2222-3333-4444-555555555555".into())
        );

        let mut supplied = serde_json::Map::new();
        supplied.insert("topic".into(), json!("My Topic"));
        supplied.insert("includeSources".into(), json!(false));
        assert!(validate_action_input(&tsx_actions[0].payload, &supplied).is_ok());

        supplied.insert("includeSources".into(), json!(true)); // constant mismatch (expected false)
        assert!(validate_action_input(&tsx_actions[0].payload, &supplied).is_err());
    }
}
