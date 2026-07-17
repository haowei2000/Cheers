//! Informed-context for native approval banners (part a of A1).
//!
//! When the gateway raises a permission_request nudge, the desktop shell wants
//! to show the approver *local* context about the tool's target path — does it
//! exist, is it a file or directory, how big, and (if it lives in a git repo)
//! the branch and whether the tree is dirty. This lets the native banner read
//! e.g. "Write /repo/src/main.rs · main · uncommitted changes" instead of a
//! bare path.
//!
//! SECURITY: this returns READ-ONLY metadata only — existence, is_dir, byte
//! size, git repo root / branch / dirty flag. It never reads file contents and
//! never emits a diff. It is deliberately NOT gated on connector roots: the
//! approval target is legitimately allowed to be a brand-new or outside path
//! (that's the whole point of asking permission), so a roots guard would defeat
//! the feature.
//!
//! KNOWN TRADEOFF (accepted, low severity): because it is not roots-gated and is
//! not correlated to a specific pending approval, any JS running in the webview
//! can call it for an ARBITRARY absolute path and learn existence + exact byte
//! size + git branch — a metadata/fingerprinting oracle (e.g. probing for
//! ~/.aws/credentials). It never discloses contents. Reaching it requires code
//! executing in the webview: the app CSP is `script-src 'self'` (no remote
//! injection without a separate frontend XSS gadget), which is the current
//! mitigation. The proper hardening — deferred as disproportionate to the risk —
//! is to correlate the requested path against the currently-pending gateway
//! permission_request and answer only for that path (or gate on an active
//! approval nudge), turning this from a free-standing oracle into a scoped lookup.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// Local metadata about a permission target path, for the native banner body.
#[derive(Debug, Clone, Serialize)]
pub struct PermissionContext {
    pub exists: bool,
    pub is_dir: bool,
    /// Byte size for a regular file; `None` for directories / missing paths.
    pub size: Option<u64>,
    /// `git rev-parse --show-toplevel` of the enclosing repo, if any.
    pub repo_root: Option<String>,
    /// Current branch (`--abbrev-ref HEAD`); `None` outside a repo / detached.
    pub branch: Option<String>,
    /// Whether `git status --porcelain` reported any change.
    pub dirty: bool,
}

/// Run `/usr/bin/git -C <dir> <args…>` read-only and return trimmed stdout on
/// success. Absolute git path (not PATH-resolved) so it can't be shadowed.
fn git_in(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("/usr/bin/git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Read-only local context for an approval target path. Never returns file
/// contents; see the module-level SECURITY note for the (intentional) absence
/// of a connector-roots guard.
#[tauri::command]
pub fn permission_context(path: String) -> Result<PermissionContext, String> {
    let target = PathBuf::from(&path);
    if !target.is_absolute() {
        return Err("expected an absolute path".into());
    }

    let meta = std::fs::metadata(&target).ok();
    let exists = meta.is_some();
    let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
    let size = meta
        .as_ref()
        .filter(|m| m.is_file())
        .map(std::fs::Metadata::len);

    // Directory to inspect for git: the path itself if it's a dir, else its
    // parent (covers a not-yet-created file the agent is about to write).
    // Canonicalize best-effort so `..` segments don't escape into a surprising
    // repo; fall back to the raw dir when the path doesn't exist yet.
    let git_dir_raw = if is_dir {
        target.clone()
    } else {
        target.parent().map(Path::to_path_buf).unwrap_or_else(|| target.clone())
    };
    let git_dir = git_dir_raw.canonicalize().unwrap_or(git_dir_raw);

    let repo_root = git_in(&git_dir, &["rev-parse", "--show-toplevel"]);
    // Only probe branch / dirty when we actually resolved a repo root.
    let (branch, dirty) = if repo_root.is_some() {
        let branch = git_in(&git_dir, &["rev-parse", "--abbrev-ref", "HEAD"])
            .filter(|b| b != "HEAD"); // detached HEAD → no branch name
        let dirty = git_in(&git_dir, &["status", "--porcelain"]).is_some();
        (branch, dirty)
    } else {
        (None, false)
    };

    Ok(PermissionContext {
        exists,
        is_dir,
        size,
        repo_root,
        branch,
        dirty,
    })
}
