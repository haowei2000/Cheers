//! Tray + dock liveness (B7, backend).
//!
//! The webview pushes a compact liveness snapshot down here on a timer; we
//! rebuild the tray menu (pending-approval count + a per-agent busy/idle roster)
//! and set the macOS dock badge to `unread + pending`. The tray is purely a
//! *display* surface — it never resolves a permission or sends a message. Any
//! decision still flows through the authenticated webview → gateway (the Rust
//! side holds no gateway JWT), so this stays on the right side of the control
//! plane by construction.
//!
//! macOS constraint: muda menu mutation and dock-badge writes must happen on the
//! main thread, so the command hops there via `run_on_main_thread`.

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

/// One agent row in the roster (matches the α2 frontend payload exactly).
#[derive(Debug, Clone, Deserialize)]
pub struct TrayAgent {
    pub name: String,
    pub busy: bool,
}

/// Show + focus the main window (tray "Open" item / left click).
fn surface(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Build the resident tray icon with its initial (static) menu and the global
/// menu-event handler. Called once from `main.rs` `.setup()`; later liveness
/// pushes swap the menu in place via [`tray_update_liveness`].
pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Cheers", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Cheers", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().expect("bundled icon"))
        .menu(&menu)
        .show_menu_on_left_click(true)
        // Global menu listener: fires for the ids of whatever menu is currently
        // set on the tray, including one swapped in by `tray_update_liveness`.
        // The roster/header items are disabled, so only "open"/"quit" arrive.
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => surface(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Rebuild the tray menu and set the dock badge from the latest snapshot. Runs
/// entirely on the main thread (menu + badge are main-thread-only on macOS).
fn rebuild(app: &AppHandle, unread: u32, pending: u32, agents: &[TrayAgent]) {
    if let Err(err) = rebuild_menu(app, pending, agents) {
        // A transient menu-rebuild failure must not take the app down; the next
        // poll will try again with fresh state.
        eprintln!("tray: menu rebuild failed: {err}");
    }
    // Dock badge = unread + pending; None clears it (0 shows no badge).
    let total = unread.saturating_add(pending);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_badge_count(if total > 0 { Some(total as i64) } else { None });
    }
}

fn rebuild_menu(app: &AppHandle, pending: u32, agents: &[TrayAgent]) -> tauri::Result<()> {
    let menu = Menu::new(app)?;

    let header = match pending {
        0 => "No pending approvals".to_string(),
        1 => "1 approval pending".to_string(),
        n => format!("{n} approvals pending"),
    };
    // Disabled (informational) header + roster rows: ids carry the `tray:`
    // prefix but are never actionable — the global handler ignores them.
    menu.append(&MenuItem::with_id(
        app,
        "tray:hdr",
        header,
        false,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "tray:agents",
        "Agents",
        false,
        None::<&str>,
    )?)?;
    if agents.is_empty() {
        menu.append(&MenuItem::with_id(
            app,
            "tray:agents:none",
            "  (none connected)",
            false,
            None::<&str>,
        )?)?;
    } else {
        for (i, agent) in agents.iter().enumerate() {
            let dot = if agent.busy { '\u{25cf}' } else { '\u{25cb}' }; // ● busy / ○ idle
            let state = if agent.busy { "busy" } else { "idle" };
            let label = format!("  {dot} {} \u{2014} {state}", agent.name);
            menu.append(&MenuItem::with_id(
                app,
                format!("tray:agent:{i}"),
                label,
                false,
                None::<&str>,
            )?)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "open",
        "Open Cheers",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "Quit Cheers",
        true,
        None::<&str>,
    )?)?;

    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

/// Webview → Rust liveness push. Rebuilds the tray roster and sets the dock
/// badge to `unread + pending` (0 clears it). Display-only; no gateway call.
#[tauri::command]
pub fn tray_update_liveness(
    app: AppHandle,
    unread: u32,
    pending: u32,
    agents: Vec<TrayAgent>,
) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || rebuild(&handle, unread, pending, &agents))
        .map_err(|e| e.to_string())
}
