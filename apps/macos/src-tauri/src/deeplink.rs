//! `cheers://` deep-link glue (tauri-plugin-deep-link v2).
//!
//! macOS delivers a `cheers://…` open in two ways depending on app state:
//!   - warm app: an Apple-event routed to `deep_link().on_open_url` while the
//!     app is already running;
//!   - cold start: the launch URL, which the plugin replays to that same
//!     handler once it is registered.
//! Because the webview's JS listener may not be mounted yet when a cold-start
//! URL arrives, we ALSO stash the most recent URL in `PendingDeepLink`; the
//! frontend drains it exactly once via `take_pending_deep_link` on startup
//! (mirrors the Web-Push cold-start drain). The live `deep-link` event covers
//! the warm-app case where a listener already exists.
//!
//! macOS caveats (documented, not enforceable here): Launch Services only
//! associates `cheers://` for the BUNDLED/installed .app — the scheme comes
//! from Info.plist `CFBundleURLTypes`, auto-injected from tauri.conf.json
//! `plugins.deep-link.desktop.schemes` at `tauri build`. `tauri dev` does NOT
//! register the scheme, and runtime (un)register is unsupported on macOS, so
//! this whole path is only exercisable from a built .app.

use std::sync::Mutex;

use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

/// Holds a `cheers://` URL that arrived before the webview's JS listener was
/// ready (cold start). Drained exactly once by `take_pending_deep_link`; the
/// warm-app path uses the live `deep-link` event instead. `manage`d in main.rs.
#[derive(Default)]
pub struct PendingDeepLink(Mutex<Option<String>>);

/// Register the `on_open_url` handler: surface the main window, stash the URL
/// for the cold-start drain, and emit a live `deep-link` event for a webview
/// that is already listening. Call once from `setup` — by then the
/// `PendingDeepLink` state is already `manage`d.
pub fn install(app: &tauri::AppHandle) {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            let url = url.to_string();
            // Bring the app forward so the routed channel becomes visible.
            crate::surface_main_window(&handle);
            // Safety net for a link that beats the JS listener (cold start)…
            if let Some(state) = handle.try_state::<PendingDeepLink>() {
                if let Ok(mut slot) = state.0.lock() {
                    *slot = Some(url.clone());
                }
            }
            // …and the live path for an already-running webview.
            let _ = handle.emit("deep-link", url);
        }
    });
}

/// Drain the cold-start URL, if any. The frontend calls this once on mount;
/// warm-app links arrive through the `deep-link` event instead. Returns null
/// (None) when there is nothing pending.
#[tauri::command]
pub fn take_pending_deep_link(state: tauri::State<'_, PendingDeepLink>) -> Option<String> {
    state.0.lock().ok().and_then(|mut slot| slot.take())
}
