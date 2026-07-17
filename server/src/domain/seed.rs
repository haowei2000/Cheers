//! Startup data bootstrap.
//!
//! A fresh database has zero users and there is no admin-seed migration, so the
//! gateway cannot be logged into out of the box. This module creates a single
//! administrator from `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_DISPLAY_NAME`
//! the first time the gateway boots against an empty `users` table.
//!
//! It is idempotent: it is a no-op once any user exists, and it skips silently
//! when `ADMIN_PASSWORD` is unset/blank (e.g. CI), so it is safe to call on
//! every startup.

use std::env;

use sqlx::{PgPool, Row};
use tracing::{info, warn};
use uuid::Uuid;

/// Create the bootstrap administrator when `users` is empty.
pub async fn ensure_admin_user(db: &PgPool) -> anyhow::Result<()> {
    let password = match env::var("ADMIN_PASSWORD") {
        Ok(p) if !p.trim().is_empty() => p,
        _ => {
            warn!("ADMIN_PASSWORD unset; skipping admin bootstrap");
            return Ok(());
        }
    };

    let existing: i64 = sqlx::query("SELECT COUNT(*) AS n FROM users")
        .fetch_one(db)
        .await?
        .try_get("n")?;
    if existing > 0 {
        return Ok(());
    }

    let username = env::var("ADMIN_USERNAME").unwrap_or_else(|_| "admin".to_string());
    let display_name =
        env::var("ADMIN_DISPLAY_NAME").unwrap_or_else(|_| "Administrator".to_string());
    // Startup-only (runs once against an empty users table), but route through the
    // spawn_blocking helper anyway so no bcrypt call runs on an async worker thread.
    let password_hash = crate::infra::crypto::hash_password(password.clone()).await?;
    let user_id = Uuid::new_v4().to_string();

    sqlx::query(
        "INSERT INTO users (user_id, username, email, password_hash, display_name, role)
         VALUES ($1, $2, NULL, $3, $4, 'system_admin')
         ON CONFLICT (username) DO NOTHING",
    )
    .bind(&user_id)
    .bind(&username)
    .bind(&password_hash)
    .bind(&display_name)
    .execute(db)
    .await?;

    info!(username = %username, "bootstrapped system_admin user");
    Ok(())
}
