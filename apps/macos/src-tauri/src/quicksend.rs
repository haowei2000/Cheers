//! Native quick-send: interactive screen capture (composer Camera button) and
//! Finder "Open With → Cheers" (RunEvent::Opened in main.rs). Both only PRODUCE
//! bytes — a `CapturedFile` the webview uploads through the SAME gateway path
//! the composer already uses (uploadFile → file_ids on send). Nothing here
//! talks to the gateway, and the human still reviews + presses Send, so the
//! control-plane red line is untouched.
//!
//! SECURITY: neither entry point takes a webview-supplied path.
//!   - `capture_screenshot` is a #[tauri::command] (reachable from
//!     remote-server-driven webview content) but takes NO path — it writes to a
//!     temp file WE name and is INTERACTIVE-ONLY (`screencapture -i`), so a
//!     hidden call still surfaces the OS crosshair, never a silent grab.
//!   - `read_opened_file` is deliberately NOT a command: its path is supplied by
//!     macOS Launch Services (Finder "Open With"), never by JS, so there is no
//!     JS-callable arbitrary-file-read primitive. It caps at MAX_OPENED_BYTES.

use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use base64::Engine as _;
use serde::Serialize;

/// Ceiling for a Finder-opened file. Attachments are small; this bounds memory
/// and the base64 IPC payload and refuses a pathological huge file.
const MAX_OPENED_BYTES: u64 = 64 * 1024 * 1024;

/// Cold-start safety net for Finder "Open With → Cheers". `RunEvent::Opened` can
/// fire before the webview has mounted a `cheers://quick-attach` listener (or
/// while no channel is open), and a plain `emit` reaches nobody. So the run-loop
/// STASHES the file here when no composer is listening, and the composer drains
/// it on mount (mirrors the deep-link `PendingDeepLink` cold-start pattern). When
/// a composer IS listening, the run-loop emits live instead — so a file is never
/// both stashed and emitted, and never re-delivered on a channel switch.
#[derive(Default)]
pub struct PendingQuickAttach {
    files: Mutex<Vec<CapturedFile>>,
    listening: AtomicBool,
}

impl PendingQuickAttach {
    /// True while a composer is mounted with a live listener + an open channel.
    pub fn is_listening(&self) -> bool {
        self.listening.load(Ordering::Relaxed)
    }

    /// Hold a file until a composer drains it (used when nobody is listening).
    pub fn stash(&self, file: CapturedFile) {
        if let Ok(mut v) = self.files.lock() {
            v.push(file);
        }
    }
}

/// Drain any files stashed while no composer was listening, and mark the composer
/// as now listening (so subsequent Finder opens emit live instead of stashing).
/// The composer calls this on mount for a channel.
#[tauri::command]
pub fn take_pending_quick_attach(
    state: tauri::State<'_, PendingQuickAttach>,
) -> Vec<CapturedFile> {
    state.listening.store(true, Ordering::Relaxed);
    state
        .files
        .lock()
        .map(|mut v| std::mem::take(&mut *v))
        .unwrap_or_default()
}

/// Mark that no composer is listening (unmount / channel closed), so Finder opens
/// stash instead of emitting into the void.
#[tauri::command]
pub fn release_quick_attach(state: tauri::State<'_, PendingQuickAttach>) {
    state.listening.store(false, Ordering::Relaxed);
}

/// Bytes produced natively, ready to feed into the frontend `uploadFile()`
/// path. Mirror of the TS `CapturedFile` in lib/desktop.ts.
#[derive(Serialize, Clone)]
pub struct CapturedFile {
    pub filename: String,
    pub content_b64: String,
    pub mime: String,
}

/// Interactive macOS screen capture. `screencapture -i` shows the SYSTEM
/// crosshair/window picker and writes the selection to a temp PNG we own; we
/// read it back as base64 and delete the temp file. INTERACTIVE-ONLY BY DESIGN
/// (see module note) — do NOT add a full-screen/silent mode. Cancelling the
/// selection (Esc) leaves no file, surfaced as a `cancelled` error the frontend
/// treats as a no-op.
#[tauri::command]
pub fn capture_screenshot() -> Result<CapturedFile, String> {
    // A temp path WE construct (never webview-supplied): no traversal surface.
    // Nanos keep repeated captures in one session from colliding.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let target = std::env::temp_dir().join(format!("cheers-shot-{stamp}.png"));

    let status = std::process::Command::new("screencapture")
        .arg("-i") // interactive selection only — system picker, never silent
        .arg("-x") // no capture sound
        .arg(&target)
        .status()
        .map_err(|e| format!("could not launch screencapture: {e}"))?;
    if !status.success() {
        return Err("screencapture failed".into());
    }
    // On Esc/cancel `screencapture` exits 0 but writes no file.
    if !target.exists() {
        return Err("cancelled".into());
    }

    let bytes = std::fs::read(&target).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&target);
    let content_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(CapturedFile {
        filename: format!(
            "screenshot-{}.png",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        ),
        content_b64,
        mime: "image/png".into(),
    })
}

/// Read a file macOS handed us via `RunEvent::Opened` (Finder "Open With →
/// Cheers" / `open -a Cheers <file>`) into a `CapturedFile`. The path is
/// OS-supplied (Launch Services), NOT webview-supplied, and this is
/// deliberately NOT a #[tauri::command]. Caps at `MAX_OPENED_BYTES`.
pub fn read_opened_file(path: &Path) -> Result<CapturedFile, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a regular file".into());
    }
    if meta.len() > MAX_OPENED_BYTES {
        return Err("file is too large to send".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    Ok(CapturedFile {
        filename,
        content_b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime: mime_for_ext(&ext).to_string(),
    })
}

/// Minimal ext→MIME map for the `fileAssociations` we register. Unknown types
/// fall back to a generic binary type; the gateway ultimately owns content-type.
fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        _ => "application/octet-stream",
    }
}
