#![cfg(feature = "integration")]

use server::domain::catalog::workbench;

#[test]
fn official_workbench_is_available_without_a_database_install() {
    let extensions = workbench::list();
    assert!(!extensions.is_empty());
    let id = extensions[0]["id"].as_str().unwrap();
    assert!(workbench::get_scene(id, "default").is_some());
}
