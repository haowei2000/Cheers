// Cheers desktop shell (macOS). Hosts the web frontend (chat shell) and acts
// as the graphical home of the connector daemon: tray residency, native
// notifications (WKWebView has no Web Push), and M1 daemon management —
// list/start/stop/logs/config for `cce-acp-connector` instances, plus a
// supervisor that revives managed daemons. Control plane stays on the
// gateway; this app never bypasses it for messages or permission decisions.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod approval;
mod audit;
mod changes;
mod connector;
mod deeplink;
mod plugins;
mod quicksend;
mod tray;

use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

/// Show + focus the main window (tray click, shortcut, second launch, deep link).
pub(crate) fn surface_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
            let _ = win.hide();
        } else {
            surface_main_window(app);
        }
    }
}

/// Summon/dismiss the Spotlight-style quick panel (declared hidden in
/// tauri.conf.json; ⌥⌘K toggles it, blur hides it — see on_window_event).
fn toggle_quick_panel(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("quickpanel") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.center();
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

fn main() {
    tauri::Builder::default()
        // Must be first: a second launch surfaces the existing window instead
        // of racing plugin state.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            surface_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(connector::SupervisorState::default())
        .manage(changes::WatchState::default())
        .manage(deeplink::PendingDeepLink::default())
        .manage(quicksend::PendingQuickAttach::default())
        .invoke_handler(tauri::generate_handler![
            connector::connector_list,
            connector::connector_start,
            connector::connector_stop,
            connector::connector_restart,
            connector::connector_delete,
            connector::connector_logs,
            connector::connector_read_config,
            connector::connector_write_config,
            connector::connector_config_read_fields,
            connector::connector_config_write_fields,
            connector::connector_write_onboarded,
            connector::connector_set_start_with_app,
            connector::connector_roots,
            connector::detect_agents,
            connector::install_agent,
            connector::available_openers,
            connector::open_path,
            connector::local_root_available,
            connector::open_local_path,
            connector::open_remote_file,
            plugins::plugins_list,
            plugins::plugins_install,
            plugins::plugins_remove,
            // A2/A3/A4/C8/C9: agent-changes watch, git, roots, audit, health, updates
            changes::connector_watch_start,
            changes::connector_watch_stop,
            changes::connector_git_status,
            changes::connector_file_diff,
            changes::connector_file_revert,
            changes::connector_open_pr,
            connector::connector_health,
            connector::connector_add_allowed_roots,
            connector::check_agent_updates,
            audit::connector_audit_timeline,
            // A1a/B7: informed approval context + tray/dock liveness
            approval::permission_context,
            tray::tray_update_liveness,
            // B5/B6: deep-link drain + interactive screenshot + Finder open-file drain
            deeplink::take_pending_deep_link,
            quicksend::capture_screenshot,
            quicksend::take_pending_quick_attach,
            quicksend::release_quick_attach,
        ])
        .setup(|app| {
            // Tray: the app is a resident; closing the window hides it and the
            // tray is the always-there handle (and the real Quit). build_tray
            // owns the menu so tray_update_liveness can swap it in place.
            tray::build_tray(app.handle())?;

            // ⌥⌘C: toggle the main window from anywhere.
            let shortcut = Shortcut::new(Some(Modifiers::ALT | Modifiers::SUPER), Code::KeyC);
            let handle = app.handle().clone();
            app.global_shortcut()
                .on_shortcut(shortcut, move |_app, _sc, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle_main_window(&handle);
                    }
                })?;

            // ⌥⌘K: summon the quick panel from anywhere.
            let qp = Shortcut::new(Some(Modifiers::ALT | Modifiers::SUPER), Code::KeyK);
            let qp_handle = app.handle().clone();
            app.global_shortcut()
                .on_shortcut(qp, move |_app, _sc, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle_quick_panel(&qp_handle);
                    }
                })?;

            // cheers:// deep links → surface + route in the webview (reuses push routing).
            deeplink::install(app.handle());

            // M1: start managed connector instances and watch over them.
            connector::spawn_supervisor(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // The quick panel is ephemeral: losing focus dismisses it (Spotlight-style).
            if window.label() == "quickpanel" {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
                return;
            }
            // Close = hide to tray; quitting is explicit via the tray menu.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Cheers desktop")
        .run(|app, event| {
            // macOS delivers Finder "Open With → Cheers" (and `open -a Cheers file`)
            // here; read each file in Rust and hand the bytes to the webview, which
            // uploads them to the CURRENT channel via the same gateway path the
            // composer uses.
            if let tauri::RunEvent::Opened { urls } = event {
                use tauri::{Emitter, Manager};
                let pending = app.state::<quicksend::PendingQuickAttach>();
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        if let Ok(captured) = quicksend::read_opened_file(&path) {
                            // Emit live only if a composer is listening; otherwise
                            // stash for its next mount so a cold-start open isn't lost.
                            if pending.is_listening() {
                                let _ = app.emit("cheers://quick-attach", captured);
                            } else {
                                pending.stash(captured);
                            }
                        }
                    }
                }
            }
        });
}
