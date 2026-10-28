//! Regenerate the reviewed wire-contract snapshot after intentional catalog changes.
fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&cheers_mcp_server::tools::definitions()).unwrap()
    );
}
