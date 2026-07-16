//! Integration tests for official workbench-plugin seeding (domain/workbench_official).
//!
//! Same harness as flows.rs: `#[sqlx::test]` provisions an isolated temp database per
//! test (runs ./migrations, drops it afterwards); needs `DATABASE_URL` pointing at a
//! Postgres that may CREATE DATABASE. Gated by the `integration` feature:
//!
//! ```bash
//! DATABASE_URL=postgres://cheers:cheers@localhost:5432/cheers \
//!   cargo test --features integration --test official_plugins
//! ```
#![cfg(feature = "integration")]

use sqlx::{PgPool, Row};

use server::domain::workbench_official::{extract_manifest, seed, OFFICIAL};

async fn plugin_rows(db: &PgPool) -> Vec<(String, String)> {
    sqlx::query("SELECT plugin_id, origin FROM workbench_plugins ORDER BY plugin_id")
        .fetch_all(db)
        .await
        .unwrap()
        .into_iter()
        .map(|r| (r.get::<String, _>("plugin_id"), r.get::<String, _>("origin")))
        .collect()
}

fn first_official_id() -> String {
    extract_manifest(OFFICIAL[0]).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[sqlx::test]
async fn seeds_full_set_on_empty_db(db: PgPool) {
    seed(&db).await.unwrap();
    let rows = plugin_rows(&db).await;
    assert_eq!(rows.len(), OFFICIAL.len());
    assert!(rows.iter().all(|(_, origin)| origin == "system"));
    let states: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workbench_official_plugin_state")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(states as usize, OFFICIAL.len());
    // bundles are actually served
    let bundle: Option<String> =
        sqlx::query_scalar("SELECT bundle FROM workbench_plugins WHERE plugin_id = $1")
            .bind(first_official_id())
            .fetch_optional(&db)
            .await
            .unwrap();
    assert!(bundle.unwrap().contains("cheers-plugin"));
}

#[sqlx::test]
async fn reseeding_same_version_is_idempotent_and_keeps_deletions(db: PgPool) {
    seed(&db).await.unwrap();
    let id = first_official_id();
    // admin deletes one official plugin
    sqlx::query("DELETE FROM workbench_plugins WHERE plugin_id = $1")
        .bind(&id)
        .execute(&db)
        .await
        .unwrap();
    // same release restarts: the deletion must stick
    seed(&db).await.unwrap();
    assert_eq!(plugin_rows(&db).await.len(), OFFICIAL.len() - 1);
}

#[sqlx::test]
async fn version_bump_restores_a_deleted_official_plugin(db: PgPool) {
    seed(&db).await.unwrap();
    let id = first_official_id();
    sqlx::query("DELETE FROM workbench_plugins WHERE plugin_id = $1")
        .bind(&id)
        .execute(&db)
        .await
        .unwrap();
    // simulate "this DB last saw an older release" — the embedded version is now higher
    sqlx::query("UPDATE workbench_official_plugin_state SET seeded_version = 0 WHERE plugin_id = $1")
        .bind(&id)
        .execute(&db)
        .await
        .unwrap();
    seed(&db).await.unwrap();
    let rows = plugin_rows(&db).await;
    assert_eq!(rows.len(), OFFICIAL.len());
    assert!(rows.iter().any(|(pid, origin)| pid == &id && origin == "system"));
}

#[sqlx::test]
async fn admin_claimed_id_is_never_overwritten(db: PgPool) {
    seed(&db).await.unwrap();
    let id = first_official_id();
    // admin deletes the official plugin, then installs their own under the same id
    sqlx::query("DELETE FROM workbench_plugins WHERE plugin_id = $1")
        .bind(&id)
        .execute(&db)
        .await
        .unwrap();
    server::domain::workbench_plugins::install(
        &db,
        &id,
        "Admin's own",
        r#"{"id":"x"}"#,
        "<html></html>",
        "someone",
        "admin",
    )
    .await
    .unwrap();
    // even a version bump must not clobber their row
    sqlx::query("UPDATE workbench_official_plugin_state SET seeded_version = 0 WHERE plugin_id = $1")
        .bind(&id)
        .execute(&db)
        .await
        .unwrap();
    seed(&db).await.unwrap();
    let title: String = sqlx::query_scalar("SELECT title FROM workbench_plugins WHERE plugin_id = $1")
        .bind(&id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(title, "Admin's own");
}
