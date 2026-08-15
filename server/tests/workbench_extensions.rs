#![cfg(feature = "integration")]

use std::io::{Cursor, Write};

use serde_json::json;
use server::domain::{workbench_extensions, workbench_official_extensions};
use sqlx::PgPool;
use zip::{write::SimpleFileOptions, ZipWriter};

fn fixture() -> Vec<u8> {
    let manifest = json!({
        "schemaVersion": 1, "id": "integration-example", "version": "1.0.0",
        "title": "Integration example", "description": "",
        "contributes": {
            "scenes": [{"id":"main","title":"Main","definition":"scenes/main.json"}],
            "renderers": []
        },
        "permissions": {}
    });
    let scene = json!({
        "items": [{"id":"notes","title":"Notes","file":"notes.md","renderer":"builtin:markdown"}],
        "seed": [{"path":"notes.md","source":"seed/main/notes.md"}], "pin": []
    });
    let mut output = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut output);
        let options = SimpleFileOptions::default();
        for (path, bytes) in [
            ("manifest.json", manifest.to_string().into_bytes()),
            ("scenes/main.json", scene.to_string().into_bytes()),
            ("seed/main/notes.md", b"# Notes".to_vec()),
        ] {
            writer.start_file(path, options).unwrap();
            writer.write_all(&bytes).unwrap();
        }
        writer.finish().unwrap();
    }
    output.into_inner()
}

#[sqlx::test]
async fn unified_extension_crud_round_trip(db: PgPool) {
    let package = workbench_extensions::validate_package(&fixture(), false).unwrap();
    workbench_extensions::install(&db, &package, "admin", "admin")
        .await
        .unwrap();
    let listed = workbench_extensions::list(&db).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["id"], "integration-example");
    let scene = workbench_extensions::get_scene(&db, "integration-example", "main")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(scene["seed"][0]["content"], "# Notes");
    assert_eq!(
        workbench_extensions::delete(&db, "integration-example")
            .await
            .unwrap(),
        1
    );
    assert!(workbench_extensions::list(&db).await.unwrap().is_empty());
}

#[sqlx::test]
async fn official_deletion_is_sticky_for_the_same_release(db: PgPool) {
    workbench_official_extensions::seed(&db).await.unwrap();
    let id: String = sqlx::query_scalar(
        "SELECT extension_id FROM workbench_extensions WHERE origin='system' ORDER BY extension_id LIMIT 1",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    workbench_extensions::delete(&db, &id).await.unwrap();
    workbench_official_extensions::seed(&db).await.unwrap();
    assert!(workbench_extensions::origin(&db, &id)
        .await
        .unwrap()
        .is_none());
    assert!(workbench_extensions::is_official_id(&db, &id)
        .await
        .unwrap());
}
