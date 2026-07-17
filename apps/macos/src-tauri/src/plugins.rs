//! Personal workbench plugins: user-installed renderer plugins that live on
//! THIS Mac, no admin required. The middle tier between a session-only temp
//! load (gone on reload) and an admin's global install (server DB, every
//! channel): a `.html` renderer bundle dropped in `~/.cheers/plugins/` is
//! loaded persistently for this user, on this machine only.
//!
//! The bundle is opaque to us — it renders inside the frontend's null-origin
//! sandbox iframe (`sandbox="allow-scripts"`, no token/DOM access), and the
//! frontend parses + validates its embedded manifest (parsePluginHtml /
//! validatePluginManifest) exactly as it does for temp loads. Rust only stores
//! files: it never executes them and never parses the manifest. It DOES enforce
//! the two invariants a filesystem store needs — a size ceiling (mirrors
//! MAX_PLUGIN_BUNDLE_BYTES) and a strict id charset so the on-disk name
//! `<id>.html` can never traverse out of the plugins directory.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

/// Matches the frontend cap (MAX_PLUGIN_BUNDLE_BYTES, pluginManifest.ts) and the
/// server's install ceiling — the sane upper bound for an iframe srcDoc.
const MAX_BUNDLE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct PersonalPlugin {
    /// Manifest id (also the on-disk basename without `.html`).
    pub id: String,
    /// The full plugin bundle (HTML/JS) — handed to the frontend as the inline
    /// `bundle`, so a personal plugin renders with no server round-trip.
    pub content: String,
}

/// `~/.cheers/plugins` — sibling of the connector home, created on first write.
fn plugins_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home directory")?;
    Ok(home.join(".cheers/plugins"))
}

/// Guard the manifest id before it becomes a filename. Mirrors the frontend's
/// `^[a-z0-9][a-z0-9._-]{0,63}$` (pluginManifest.ts validatePluginManifest) — no
/// slash, no `..`, so `<id>.html` is always a leaf under the plugins directory.
/// Defense in depth: the frontend already validated, but this command boundary
/// is reachable independently and must not trust its caller.
fn guard_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && id.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        });
    if ok {
        Ok(())
    } else {
        Err(format!(
            "invalid plugin id {id:?}: must match ^[a-z0-9][a-z0-9._-]{{0,63}}$"
        ))
    }
}

// The command handlers are thin wrappers over dir-parameterized cores so the
// file-store round-trip is unit-testable against a temp dir (plugins_dir() is
// the only untestable part — it just resolves ~/.cheers/plugins).

/// List installed personal plugins: every `<id>.html` under `dir` whose name is
/// a valid id and whose body is within the size cap. A malformed or oversized
/// file is skipped (not fatal) — the frontend validates the manifest and simply
/// won't offer a plugin it can't parse. A missing dir means nothing installed.
fn list_in(dir: &Path) -> Result<Vec<PersonalPlugin>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("read {}: {e}", dir.display())),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|_| path.extension().and_then(|e| e.to_str()) == Some("html"))
        else {
            continue;
        };
        if guard_id(id).is_err() {
            continue;
        }
        match fs::read_to_string(&path) {
            Ok(content) if content.len() <= MAX_BUNDLE_BYTES => out.push(PersonalPlugin {
                id: id.to_string(),
                content,
            }),
            _ => continue,
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Install (or update) a personal plugin into `dir`. Same-id overwrites — that
/// IS the update path, mirroring how a same-id session load shadows the previous.
fn install_in(dir: &Path, id: &str, content: &str) -> Result<(), String> {
    guard_id(id)?;
    if content.len() > MAX_BUNDLE_BYTES {
        return Err(format!(
            "plugin bundle exceeds {} MiB",
            MAX_BUNDLE_BYTES / (1024 * 1024)
        ));
    }
    fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{id}.html"));
    fs::write(&path, content).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Uninstall a personal plugin by id from `dir`. Idempotent: removing one that
/// isn't there is a no-op, not an error (the list may be stale by a click).
fn remove_in(dir: &Path, id: &str) -> Result<(), String> {
    guard_id(id)?;
    let path = dir.join(format!("{id}.html"));
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove {}: {e}", path.display())),
    }
}

#[tauri::command]
pub fn plugins_list() -> Result<Vec<PersonalPlugin>, String> {
    list_in(&plugins_dir()?)
}

#[tauri::command]
pub fn plugins_install(id: String, content: String) -> Result<(), String> {
    install_in(&plugins_dir()?, &id, &content)
}

#[tauri::command]
pub fn plugins_remove(id: String) -> Result<(), String> {
    remove_in(&plugins_dir()?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique temp dir under the OS temp root, keyed by test name (no external
    /// tempdir crate; std only). Removed + recreated so each run starts clean.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cheers-plugins-test-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn guard_id_matches_frontend_charset() {
        // Accepted: the frontend's ^[a-z0-9][a-z0-9._-]{0,63}$.
        for ok in ["codemap", "a", "my.plugin_v2-1", "0abc"] {
            assert!(guard_id(ok).is_ok(), "should accept {ok:?}");
        }
        // Rejected: traversal, separators, uppercase, empty, leading dot, too long.
        for bad in [
            "../evil",
            "a/b",
            "a b",
            "Abc",
            "",
            ".hidden",
            &"x".repeat(65),
        ] {
            assert!(guard_id(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn install_list_remove_round_trip() {
        let dir = scratch("roundtrip");
        // Empty (missing dir) lists nothing.
        assert_eq!(list_in(&dir).unwrap().len(), 0);

        install_in(&dir, "codemap", "<html>A</html>").unwrap();
        install_in(&dir, "table.v2", "<html>B</html>").unwrap();
        let listed = list_in(&dir).unwrap();
        assert_eq!(listed.len(), 2);
        // Sorted by id: codemap before table.v2.
        assert_eq!(listed[0].id, "codemap");
        assert_eq!(listed[0].content, "<html>A</html>");
        assert_eq!(listed[1].id, "table.v2");

        // Same-id install overwrites (update path).
        install_in(&dir, "codemap", "<html>A2</html>").unwrap();
        let after = list_in(&dir).unwrap();
        assert_eq!(after.len(), 2);
        assert_eq!(after[0].content, "<html>A2</html>");

        // Remove is idempotent.
        remove_in(&dir, "codemap").unwrap();
        remove_in(&dir, "codemap").unwrap();
        let left = list_in(&dir).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, "table.v2");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_skips_oversize_and_foreign_files() {
        let dir = scratch("skip");
        fs::create_dir_all(&dir).unwrap();
        // A non-html file and an invalid-id html file are both ignored.
        fs::write(dir.join("notes.txt"), "x").unwrap();
        fs::write(dir.join("Bad Id.html"), "x").unwrap();
        // An oversize bundle is skipped, not returned.
        install_in(&dir, "big", "<html>ok</html>").unwrap();
        fs::write(dir.join("huge.html"), "x".repeat(MAX_BUNDLE_BYTES + 1)).unwrap();
        let listed = list_in(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "big");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_rejects_oversize_and_bad_id() {
        let dir = scratch("reject");
        assert!(install_in(&dir, "ok", &"x".repeat(MAX_BUNDLE_BYTES + 1)).is_err());
        assert!(install_in(&dir, "../escape", "<html>x</html>").is_err());
        // Nothing was written.
        assert_eq!(list_in(&dir).unwrap().len(), 0);
        let _ = fs::remove_dir_all(&dir);
    }
}
