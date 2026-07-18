//! A2 — Agent-changes watch. A per-connector FSEvents watcher (the `notify`
//! crate → `FsEventWatcher` on macOS) watches a daemon's workspace directory and
//! emits a debounced Tauri `connector-changes` event to the webview; git
//! status/diff/revert/open-PR are shelled out to `git`/`gh` via
//! `std::process::Command` (same pattern as connector.rs' open/mdfind/kill).
//!
//! Control plane is untouched: this only DISPLAYS local workspace state and
//! opens local tools. Every path arg reachable from the (remote-content-driven)
//! webview is canonicalized and asserted inside the connector workdir — the same
//! guard connector.rs' `open_path` applies — so `connector_file_diff`/`_revert`
//! can't be turned into an arbitrary-file read/write primitive.

use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Coalesce FSEvents bursts (editor save = many events) into one emit.
const DEBOUNCE_MS: u64 = 300;

/// Active watchers, keyed by connector name. Managed via `app.manage` in main.rs.
/// Dropping a `WatchEntry` drops its `RecommendedWatcher` (stops FSEvents) and
/// the coalescing thread exits once its channel disconnects or `stop` is set.
#[derive(Default)]
pub struct WatchState {
    watchers: Mutex<HashMap<String, WatchEntry>>,
}

struct WatchEntry {
    // Held only to keep the watch alive; dropping it unwatches.
    _watcher: RecommendedWatcher,
    stop: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChangedFile {
    /// Path relative to the workdir (falls back to absolute if outside).
    pub path: String,
    /// "create" | "modify" | "remove" | "other".
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
struct ChangesPayload {
    name: String,
    files: Vec<ChangedFile>,
    /// Recomputed on each batch so the panel header updates without a round-trip.
    git: Option<GitStatus>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileStatus {
    pub path: String,
    /// The two-char porcelain code, trimmed (e.g. "M", "??", "A").
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: String,
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileStatus>,
}

/// The workspace directory the watcher/git commands operate on: the daemon cwd
/// (daemon.json) or, failing that, the first configured `allowed_root`. Reuses
/// connector.rs' `connector_roots`, which already tilde-expands and keeps only
/// existing directories. Canonicalized so it can anchor the path guard.
fn workdir_for(name: &str) -> Result<PathBuf, String> {
    let roots = crate::connector::connector_roots(name.to_string())?;
    let dir = roots
        .cwd
        .or_else(|| roots.roots.into_iter().next())
        .ok_or("this connector has no local workspace directory")?;
    PathBuf::from(&dir)
        .canonicalize()
        .map_err(|e| format!("workspace directory is unavailable: {e}"))
}

/// PATH GUARD (load-bearing): resolve a webview-supplied relative path under the
/// workdir and prove it can't escape. Absolute inputs and `..` are rejected
/// outright; the parent directory is canonicalized (defeating symlink escapes)
/// and asserted to start with the canonical workdir. Returns the workdir and the
/// guarded absolute path. The parent is canonicalized (not the leaf) so a
/// deleted-but-tracked file (revert target) still validates.
fn resolve_in_workdir(name: &str, relpath: &str) -> Result<(PathBuf, PathBuf), String> {
    let workdir = workdir_for(name)?;
    let rel = Path::new(relpath);
    if rel.is_absolute()
        || rel.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("invalid path".into());
    }
    let joined = workdir.join(rel);
    let parent = joined.parent().ok_or("invalid path")?;
    let file = joined.file_name().ok_or("invalid path")?;
    let canon_parent = parent
        .canonicalize()
        .map_err(|_| "path does not exist".to_string())?;
    if !canon_parent.starts_with(&workdir) {
        return Err("path is outside the connector workspace".into());
    }
    Ok((workdir, canon_parent.join(file)))
}

/// `git -C <workdir> <args…>` collecting output (git is on the default PATH).
fn git(workdir: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    std::process::Command::new("git")
        .arg("-C")
        .arg(workdir)
        .args(args)
        .output()
        .map_err(|e| e.to_string())
}

fn kind_str(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "create",
        EventKind::Modify(_) => "modify",
        EventKind::Remove(_) => "remove",
        _ => "other",
    }
}

/// Skip the noise directories that would otherwise storm the watcher.
fn ignored(rel: &Path) -> bool {
    rel.components().any(|c| {
        matches!(
            c.as_os_str().to_str(),
            Some(".git") | Some("node_modules") | Some("target")
        )
    })
}

/// Turn a debounced batch of raw notify events into a deduped changed-file list
/// (last kind wins per path, ignored dirs dropped).
fn batch_to_files(workdir: &Path, events: &[Event]) -> Vec<ChangedFile> {
    let mut seen: HashMap<String, String> = HashMap::new();
    for ev in events {
        let kind = kind_str(&ev.kind);
        for p in &ev.paths {
            let rel = p.strip_prefix(workdir).unwrap_or(p);
            if ignored(rel) {
                continue;
            }
            let key = rel.to_string_lossy().into_owned();
            if key.is_empty() {
                continue;
            }
            seen.insert(key, kind.to_string());
        }
    }
    seen.into_iter()
        .map(|(path, kind)| ChangedFile { path, kind })
        .collect()
}

#[tauri::command]
pub fn connector_watch_start(
    app: AppHandle,
    state: tauri::State<'_, WatchState>,
    name: String,
) -> Result<(), String> {
    let workdir = workdir_for(&name)?;

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&workdir, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let stop = Arc::new(AtomicBool::new(false));

    // Coalescing thread: block on the first event, drain the rest for a short
    // window, then recompute git status and emit once. The watcher is the
    // trigger only — `git status` is the source of truth (so an FSEvents storm
    // over a big tree stays cheap).
    {
        let stop = stop.clone();
        let app = app.clone();
        let name = name.clone();
        let workdir = workdir.clone();
        std::thread::spawn(move || loop {
            let first = match rx.recv() {
                Ok(r) => r,
                Err(_) => break, // watcher dropped
            };
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let mut raw = vec![first];
            let deadline = Instant::now() + Duration::from_millis(DEBOUNCE_MS);
            while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
                match rx.recv_timeout(remaining) {
                    Ok(r) => raw.push(r),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let events: Vec<Event> = raw.into_iter().flatten().collect();
            let files = batch_to_files(&workdir, &events);
            if files.is_empty() {
                continue;
            }
            let git = compute_git_status(&workdir);
            let _ = app.emit(
                "connector-changes",
                ChangesPayload {
                    name: name.clone(),
                    files,
                    git: Some(git),
                },
            );
        });
    }

    // Replacing an existing entry drops (and thus stops) the previous watcher.
    let mut map = state.watchers.lock().unwrap();
    if let Some(prev) = map.insert(
        name,
        WatchEntry {
            _watcher: watcher,
            stop,
        },
    ) {
        prev.stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub fn connector_watch_stop(
    state: tauri::State<'_, WatchState>,
    name: String,
) -> Result<(), String> {
    if let Some(entry) = state.watchers.lock().unwrap().remove(&name) {
        entry.stop.store(true, Ordering::Relaxed);
        // entry (its watcher) is dropped here → FSEvents stops, thread exits.
    }
    Ok(())
}

/// Parse `git status --porcelain=v1 --branch` into branch/ahead/behind + files.
fn parse_status(text: &str) -> (String, u32, u32, Vec<FileStatus>) {
    let mut branch = String::new();
    let (mut ahead, mut behind) = (0u32, 0u32);
    let mut files = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            // "<branch>...<upstream> [ahead N, behind M]"
            branch = rest
                .split("...")
                .next()
                .unwrap_or(rest)
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_string();
            if let (Some(lb), Some(rb)) = (rest.find('['), rest.find(']')) {
                if lb < rb {
                    for token in rest[lb + 1..rb].split(',') {
                        let t = token.trim();
                        if let Some(n) = t.strip_prefix("ahead ") {
                            ahead = n.trim().parse().unwrap_or(0);
                        } else if let Some(n) = t.strip_prefix("behind ") {
                            behind = n.trim().parse().unwrap_or(0);
                        }
                    }
                }
            }
            continue;
        }
        if line.len() < 3 {
            continue;
        }
        let status = line[..2].trim().to_string();
        let mut path = line[3..].to_string();
        // Renames render "old -> new"; report the destination.
        if let Some(idx) = path.find(" -> ") {
            path = path[idx + 4..].to_string();
        }
        files.push(FileStatus { path, status });
    }
    (branch, ahead, behind, files)
}

fn compute_git_status(workdir: &Path) -> GitStatus {
    let inside = git(workdir, &["rev-parse", "--is-inside-work-tree"])
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !inside {
        return GitStatus {
            is_repo: false,
            branch: String::new(),
            dirty: false,
            ahead: 0,
            behind: 0,
            files: Vec::new(),
        };
    }
    let text = git(workdir, &["status", "--porcelain=v1", "--branch"])
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let (branch, ahead, behind, files) = parse_status(&text);
    GitStatus {
        is_repo: true,
        dirty: !files.is_empty(),
        branch,
        ahead,
        behind,
        files,
    }
}

#[tauri::command]
pub fn connector_git_status(name: String) -> Result<GitStatus, String> {
    let workdir = workdir_for(&name)?;
    Ok(compute_git_status(&workdir))
}

#[tauri::command]
pub fn connector_file_diff(name: String, path: String) -> Result<String, String> {
    // PATH GUARD: reject anything that escapes the workdir before touching git.
    let (workdir, _guarded) = resolve_in_workdir(&name, &path)?;
    let out = git(&workdir, &["diff", "HEAD", "--", &path])?;
    let diff = String::from_utf8_lossy(&out.stdout).into_owned();
    if !diff.trim().is_empty() {
        return Ok(diff);
    }
    // Untracked file: show its full content as additions (git diff --no-index
    // exits non-zero when there ARE differences, so read stdout regardless).
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&workdir)
        .args(["diff", "--no-index", "--", "/dev/null", &path])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command]
pub fn connector_file_revert(name: String, path: String) -> Result<(), String> {
    // PATH GUARD: destructive (discards uncommitted edits) — guard first.
    let (workdir, _guarded) = resolve_in_workdir(&name, &path)?;
    // `checkout HEAD -- <path>` restores tracked files; untracked paths fail the
    // pathspec (returned as an error), which is the desired no-op there.
    let out = git(&workdir, &["checkout", "HEAD", "--", &path])?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// git@host:owner/repo(.git) or https://host/owner/repo(.git) → https browse URL.
fn remote_to_https(url: &str) -> Option<String> {
    let url = url.trim();
    let stripped = url.strip_suffix(".git").unwrap_or(url);
    if let Some(rest) = stripped.strip_prefix("git@") {
        // host:owner/repo → https://host/owner/repo
        let rest = rest.replacen(':', "/", 1);
        return Some(format!("https://{rest}"));
    }
    if stripped.starts_with("http://") || stripped.starts_with("https://") {
        return Some(stripped.to_string());
    }
    None
}

#[tauri::command]
pub fn connector_open_pr(name: String) -> Result<(), String> {
    let workdir = workdir_for(&name)?;

    // Preferred path: `gh pr create --web` (opens the browser form). gh lives on
    // the user's login PATH, which a GUI-launched app doesn't inherit, so
    // resolve it the same way connector.rs finds agent adapters.
    if let Some(gh) = crate::connector::resolve_on_login_path("gh") {
        let ok = std::process::Command::new(gh)
            .current_dir(&workdir)
            .args(["pr", "create", "--web"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Ok(());
        }
    }

    // Fallback: derive a compare URL from the user's OWN `origin` remote (never
    // from observed/remote content) and open it. This only opens a browser form;
    // it does not create anything without the user acting.
    let remote = git(&workdir, &["remote", "get-url", "origin"])?;
    if !remote.status.success() {
        return Err("no gh CLI and no 'origin' remote to open a PR against".into());
    }
    let url = String::from_utf8_lossy(&remote.stdout).into_owned();
    let base = remote_to_https(&url).ok_or("could not derive a web URL from origin")?;
    let branch = git(&workdir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|b| !b.is_empty() && b != "HEAD")
        .ok_or("cannot open a PR from a detached HEAD")?;
    let compare = format!("{base}/compare/{branch}?expand=1");
    std::process::Command::new("open")
        .arg(&compare)
        .status()
        .map_err(|e| e.to_string())
        .and_then(|s| {
            if s.success() {
                Ok(())
            } else {
                Err("could not open the compare URL".into())
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_ahead_behind_and_files() {
        let text = "## main...origin/main [ahead 2, behind 1]\n M src/a.rs\n?? new.txt\nR  old.rs -> new.rs\n";
        let (branch, ahead, behind, files) = parse_status(text);
        assert_eq!(branch, "main");
        assert_eq!(ahead, 2);
        assert_eq!(behind, 1);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, "M");
        assert_eq!(files[0].path, "src/a.rs");
        assert_eq!(files[1].status, "??");
        assert_eq!(files[2].path, "new.rs"); // rename → destination
    }

    #[test]
    fn parses_no_upstream_branch() {
        let (branch, ahead, behind, files) = parse_status("## feature-x\n");
        assert_eq!(branch, "feature-x");
        assert_eq!((ahead, behind), (0, 0));
        assert!(files.is_empty());
    }

    #[test]
    fn ignores_noise_dirs() {
        assert!(ignored(Path::new(".git/index")));
        assert!(ignored(Path::new("node_modules/x/y.js")));
        assert!(ignored(Path::new("target/debug/foo")));
        assert!(!ignored(Path::new("src/main.rs")));
    }

    #[test]
    fn remote_url_forms() {
        assert_eq!(
            remote_to_https("git@github.com:acme/cheers.git").as_deref(),
            Some("https://github.com/acme/cheers")
        );
        assert_eq!(
            remote_to_https("https://github.com/acme/cheers.git").as_deref(),
            Some("https://github.com/acme/cheers")
        );
        assert_eq!(remote_to_https("/local/path"), None);
    }
}
