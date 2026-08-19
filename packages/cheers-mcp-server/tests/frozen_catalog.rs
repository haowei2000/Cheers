//! The MCP tool catalog is wire contract: connected Agents see these names,
//! schemas, and scopes, and clients render tools in the order the server sends
//! them. `tests/frozen-tool-catalog.json` is the catalog exactly as it was
//! hand-written before `registry.rs` generated it.
//!
//! A diff here means the generated projection drifted from the frozen contract.
//! That is sometimes intended — adding a tool, correcting a description — but
//! it is never incidental, so update the snapshot in the same commit that
//! changes the registry and say why in the message.

#[test]
fn generated_catalog_matches_the_frozen_contract() {
    let frozen: serde_json::Value =
        serde_json::from_str(include_str!("frozen-tool-catalog.json")).expect("snapshot parses");
    let generated = serde_json::Value::Array(cheers_mcp_server::tools::definitions());
    assert_eq!(
        frozen, generated,
        "generated tool catalog drifted from tests/frozen-tool-catalog.json"
    );
}
