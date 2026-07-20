//! M1: connector daemon management. The GUI drives the EXISTING
//! `cce-acp-connector` CLI (bundled as a Tauri sidecar) — start/stop/restart/
//! logs are its subcommands, and instance state is read straight from the
//! connector's own `daemon.json` metadata (same fields as its
//! `daemon::DaemonMetadata`; the connector is not modified). The app also
//! plays supervisor: instances the user marks "start with app" are launched
//! on boot and revived when their process dies (the macOS answer to the
//! systemd-linger pitfall on Linux).

use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::ShellExt;

/// Mirror of the connector's `DaemonMetadata` (serde field names must match
/// packages/cheers-acp-connector-rs/src/daemon.rs — schema_version 1).
#[derive(Debug, Clone, Deserialize)]
struct DaemonMetadata {
    name: String,
    pid: u32,
    config_path: PathBuf,
    started_at: String,
    stdout_log_path: PathBuf,
    #[allow(dead_code)]
    stderr_log_path: PathBuf,
    #[serde(default)]
    cwd: Option<PathBuf>,
    /// The daemon's process group (recorded in daemon.json); the adapter child
    /// inherits it, so `ps -g <pgid>` totals daemon + adapter for the health
    /// panel. Absent on older metadata → fall back to sampling the pid alone.
    #[serde(default)]
    process_group_id: Option<u32>,
}

/// The local workspace roots the desktop can open in Finder: the daemon's cwd
/// plus the connector config's `[policy.workspace]` roots. This is the M2
/// "same-machine" seam at its most basic — the desktop, being on the same box,
/// can open the exact directories the agent operates in (the browser can't).
#[derive(Debug, Clone, Serialize, Default)]
pub struct ConnectorRoots {
    /// Daemon working directory (from daemon.json), if recorded and it exists.
    pub cwd: Option<String>,
    /// `allowed_roots` / `default_cwd` from the config TOML that exist on disk.
    pub roots: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectorInstance {
    pub name: String,
    pub running: bool,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub config_path: Option<String>,
    pub stdout_log: Option<String>,
    pub start_with_app: bool,
}

/// Instances the app currently expects to be running: marked start-with-app
/// at boot, added on GUI start, removed on GUI stop. The supervisor only
/// revives instances in this set, so a deliberate stop stays stopped.
#[derive(Default)]
pub struct SupervisorState {
    managed: Mutex<HashSet<String>>,
}

/// `$CHEERS_ACP_HOME` or `~/.cheers/acp-connector` — same resolution as the
/// connector's `default_home_dir`.
fn connector_home() -> Option<PathBuf> {
    if let Ok(home) = env::var("CHEERS_ACP_HOME") {
        return Some(PathBuf::from(home));
    }
    dirs::home_dir().map(|h| h.join(".cheers/acp-connector"))
}

/// App-side settings (which instances start with the app). Lives next to the
/// connector home, NOT inside it — the connector owns its own directory.
fn settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".cheers/desktop.json"))
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct DesktopSettings {
    #[serde(default)]
    start_with_app: HashSet<String>,
}

fn load_settings() -> DesktopSettings {
    settings_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_settings(settings: &DesktopSettings) -> Result<(), String> {
    let path = settings_path().ok_or("no home directory")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(
        path,
        serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Reproduce the connector CLI's instance-name sanitization
/// (packages/cheers-acp-connector-rs/src/daemon.rs `safe_name`): the daemon
/// directory + `daemon.json.name` use the sanitized form, so the supervisor's
/// `managed` set and `start_with_app` must key on the same value or a name
/// with a space/slash (e.g. "My Bot" → "My-Bot") would never match and revive
/// would silently break. Must stay in sync with the connector's function.
fn safe_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut previous_dash = false;
    for ch in name.trim().chars() {
        let valid = ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-';
        if valid {
            out.push(ch);
            previous_dash = false;
        } else if !previous_dash {
            out.push('-');
            previous_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "default".to_string()
    } else {
        trimmed
    }
}

/// The connector validates liveness as pid-alive AND argv-match; for the GUI
/// list, `kill -0` is enough (the CLI re-validates before acting).
fn pid_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Find an instance's daemon.json by its logical `name` field.
fn read_metadata_by_name(name: &str) -> Option<DaemonMetadata> {
    let home = connector_home()?;
    let entries = fs::read_dir(&home).ok()?;
    for entry in entries.flatten() {
        let meta: Option<DaemonMetadata> = fs::read_to_string(entry.path().join("daemon.json"))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok());
        if let Some(m) = meta {
            if m.name == name {
                return Some(m);
            }
        }
    }
    None
}

/// The stdout log path an instance writes to (recorded in its daemon.json), for
/// the read-only audit-timeline parser (audit.rs). None when the instance has
/// no (readable) metadata yet. Same trust model as `connector_logs`: the path
/// is connector-owned, not webview-supplied.
pub(crate) fn stdout_log_path_for(name: &str) -> Option<PathBuf> {
    read_metadata_by_name(name).map(|m| m.stdout_log_path)
}

fn read_instances() -> Vec<ConnectorInstance> {
    let settings = load_settings();
    let Some(home) = connector_home() else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&home) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let meta_path = entry.path().join("daemon.json");
        let dir_name = entry.file_name().to_string_lossy().to_string();
        let meta: Option<DaemonMetadata> = fs::read_to_string(&meta_path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok());
        match meta {
            Some(m) => {
                let running = pid_alive(m.pid);
                out.push(ConnectorInstance {
                    start_with_app: settings.start_with_app.contains(&m.name),
                    name: m.name,
                    running,
                    pid: running.then_some(m.pid),
                    started_at: Some(m.started_at),
                    config_path: Some(m.config_path.to_string_lossy().into_owned()),
                    stdout_log: Some(m.stdout_log_path.to_string_lossy().into_owned()),
                });
            }
            // A service dir without (readable) metadata still shows up, so a
            // half-created instance isn't invisible in the GUI. Pair it with
            // the desktop-owned onboarding config when present so users can
            // fix a failed first launch instead of being stranded.
            None if entry.path().is_dir() => {
                let config_path = dirs::home_dir()
                    .map(|h| {
                        h.join(".cheers")
                            .join(format!("cheers-daemon.{dir_name}.toml"))
                    })
                    .filter(|p| p.exists())
                    .map(|p| p.to_string_lossy().into_owned());
                out.push(ConnectorInstance {
                    start_with_app: settings.start_with_app.contains(&dir_name),
                    name: dir_name,
                    running: false,
                    pid: None,
                    started_at: None,
                    config_path,
                    stdout_log: None,
                })
            }
            None => {}
        }
    }
    // `daemon.json` exists only after a successful daemon start. Onboarding writes
    // the config first, so a bad adapter must still be visible, editable, and
    // retryable instead of disappearing from the desktop after its first crash.
    let config_home = dirs::home_dir().map(|h| h.join(".cheers"));
    if let Some(config_home) = config_home {
        if let Ok(entries) = fs::read_dir(config_home) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(file) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                let Some(name) = file
                    .strip_prefix("cheers-daemon.")
                    .and_then(|n| n.strip_suffix(".toml"))
                else {
                    continue;
                };
                if out.iter().any(|instance| instance.name == name) {
                    continue;
                }
                out.push(ConnectorInstance {
                    start_with_app: settings.start_with_app.contains(name),
                    name: name.to_string(),
                    running: false,
                    pid: None,
                    started_at: None,
                    config_path: Some(path.to_string_lossy().into_owned()),
                    stdout_log: None,
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Run the sidecar CLI and return its stdout (stderr appended on failure).
async fn run_cli(app: &tauri::AppHandle, args: &[&str]) -> Result<String, String> {
    let cmd = app
        .shell()
        .sidecar("cce-acp-connector")
        .map_err(|e| format!("sidecar unavailable: {e}"))?
        .args(args);
    let output = cmd.output().await.map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() {
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("{stdout}{stderr}").trim().to_string())
    }
}

/// Advisory thresholds for the health panel (summed across the process group).
/// Deliberately high so a legitimately busy agent (one pegged core, a large
/// model context) isn't flagged — the panel only nudges "consider restarting".
const HIGH_CPU_PCT: f32 = 150.0;
const HIGH_MEM_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB

/// Live resource usage of a running connector, sampled from `ps` over the
/// daemon's process group. The adapter subprocess inherits that group (it is
/// spawned without setsid), so this totals the daemon AND its agent adapter —
/// where the real CPU/memory goes during a run. Advisory only: the supervisor
/// already revives daemons that have actually died; this surfaces a
/// hung/runaway one so the user can restart it.
///
/// Shape follows the γ1↔γ2 shared contract (`pid`/`cpu_pct`/`mem_mb`/`hung`)
/// with the byte/state/status fields as additive detail.
#[derive(Debug, Clone, Serialize)]
pub struct ConnectorHealth {
    pub pid: u32,
    /// Summed %CPU across the group (can exceed 100 on multiple cores).
    pub cpu_pct: f32,
    /// Summed resident memory across the group, in megabytes.
    pub mem_mb: f32,
    /// True when the leader is wedged (zombie/stopped) — the "not responding" case.
    pub hung: bool,
    /// Summed resident memory across the group, in bytes.
    pub mem_bytes: u64,
    /// Live processes in the group (daemon + adapter + any children).
    pub process_count: u32,
    /// `ps` state of the daemon leader ("S", "R", "Z", "T"…), if seen.
    pub leader_state: Option<String>,
    /// Computed advisory: "healthy" | "high_cpu" | "high_mem" | "stuck".
    pub status: String,
}

/// Parse `ps -o pid=,rss=,%cpu=,stat=` output: sum RSS (KiB→bytes) and %CPU,
/// count rows, capture the leader's state (row whose pid == `pid`). Pure over
/// the text so it's unit-testable without a live process.
fn parse_ps_group(text: &str, pid: u32) -> Option<(f32, u64, u32, Option<String>)> {
    let mut cpu = 0.0f32;
    let mut mem: u64 = 0;
    let mut count = 0u32;
    let mut leader_state = None;
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let (Some(row_pid), Some(rss), Some(pcpu), stat) =
            (it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let Ok(row_pid) = row_pid.parse::<u32>() else {
            continue;
        };
        mem += rss.parse::<u64>().unwrap_or(0).saturating_mul(1024);
        cpu += pcpu.parse::<f32>().unwrap_or(0.0);
        count += 1;
        if row_pid == pid {
            leader_state = stat.map(str::to_string);
        }
    }
    (count > 0).then_some((cpu, mem, count, leader_state))
}

/// Sample `ps` for one process group (or a single pid when no pgid is known).
/// macOS `ps`: `%cpu` is a decaying-average snapshot (non-zero without a second
/// sample); `rss` is KiB. `=`-suffixed fields drop the header row.
fn sample_group(pid: u32, pgid: Option<u32>) -> Option<(f32, u64, u32, Option<String>)> {
    let mut cmd = std::process::Command::new("ps");
    cmd.arg("-o").arg("pid=,rss=,%cpu=,stat=");
    match pgid {
        Some(g) => cmd.arg("-g").arg(g.to_string()),
        None => cmd.arg("-p").arg(pid.to_string()),
    };
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_ps_group(&String::from_utf8_lossy(&out.stdout), pid)
}

fn classify_health(cpu_pct: f32, mem_bytes: u64, leader_state: Option<&str>) -> String {
    // A zombie ('Z') or stopped ('T') leader still passes `kill -0`, so the
    // supervisor won't revive it — exactly the stuck case worth surfacing.
    if leader_state
        .map(|s| s.starts_with('Z') || s.starts_with('T'))
        .unwrap_or(false)
    {
        return "stuck".into();
    }
    if cpu_pct >= HIGH_CPU_PCT {
        "high_cpu".into()
    } else if mem_bytes >= HIGH_MEM_BYTES {
        "high_mem".into()
    } else {
        "healthy".into()
    }
}

/// Live health for ONE running connector instance (by daemon.json `name`).
/// Advisory panel data — returns null (None) when the instance isn't running or
/// can't be sampled. RED LINE: only DISPLAYS local metrics; no messages or
/// permission decisions are introduced.
#[tauri::command]
pub fn connector_health(name: String) -> Option<ConnectorHealth> {
    let m = read_metadata_by_name(&name)?;
    if !pid_alive(m.pid) {
        return None;
    }
    let (cpu_pct, mem_bytes, process_count, leader_state) =
        sample_group(m.pid, m.process_group_id)?;
    let status = classify_health(cpu_pct, mem_bytes, leader_state.as_deref());
    Some(ConnectorHealth {
        pid: m.pid,
        cpu_pct,
        mem_mb: (mem_bytes as f64 / (1024.0 * 1024.0)) as f32,
        hung: status == "stuck",
        mem_bytes,
        process_count,
        leader_state,
        status,
    })
}

#[tauri::command]
pub fn connector_list() -> Vec<ConnectorInstance> {
    read_instances()
}

#[tauri::command]
pub async fn connector_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, SupervisorState>,
    config_path: String,
    name: String,
) -> Result<String, String> {
    // A connector config names an adapter command the daemon executes, so a
    // config path is an RCE vector if the (remote-content-driven) webview can
    // point it anywhere. Confine startable configs to the connector's own
    // directory tree (`~/.cheers/`), where onboarding writes them.
    guard_startable_config(&config_path)?;
    // The CLI sanitizes --name to form the daemon dir + daemon.json.name;
    // track that same form so the supervisor's revive/start-with-app matches
    // (the free-text "new instance" form can pass "My Bot" → daemon "My-Bot").
    let name = safe_name(&name);
    // Zero-prep for "start from an existing .toml" too (onboarding already does
    // this, but a hand-picked config wouldn't have its workspace dirs created).
    // Older desktop-created configs can still point at an npm JS shim with an
    // `env node` shebang. Normalize again at launch so a previously failed
    // first setup is repaired by Retry, without requiring the user to find and
    // edit a TOML file themselves.
    let current_config = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    let normalized_config = normalize_adapter_launcher(&current_config)?;
    if normalized_config != current_config {
        fs::write(&config_path, &normalized_config).map_err(|e| e.to_string())?;
    }
    ensure_workspace_dirs(&normalized_config);
    let out = run_cli(&app, &["--name", &name, "--config", &config_path, "start"]).await?;
    state.managed.lock().unwrap().insert(name);
    Ok(out)
}

/// The user's login-shell `PATH`, so we can find agent adapters installed in
/// homebrew/npm/cargo bins that a GUI-launched app never sees. Falls back to
/// common locations if the shell can't be probed.
fn login_path_dirs() -> Vec<PathBuf> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // `command -v` printing $PATH via a login+interactive shell loads the
    // user's real PATH (.zprofile/.zshrc). No user input is interpolated.
    let out = std::process::Command::new(&shell)
        .args(["-lic", "printf %s \"$PATH\""])
        .output()
        .ok();
    let mut path_dirs: Vec<PathBuf> = out
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .map(|p| {
            p.split(':')
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default();
    // Belt-and-suspenders: common install roots even if the probe missed them.
    if let Some(home) = dirs::home_dir() {
        for extra in [".local/bin", ".cargo/bin", ".bun/bin", ".npm-global/bin"] {
            path_dirs.push(home.join(extra));
        }
    }
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        path_dirs.push(PathBuf::from(extra));
    }
    path_dirs
}

/// Known ACP agents: (key, label, primary command, npm/other install command).
/// An empty install command means "no known installer" (e.g. gemini has no
/// ACP adapter yet). Install strings are constants — never user input — so
/// running them through the login shell can't inject.
const KNOWN_AGENTS: &[(&str, &str, &str, &str)] = &[
    (
        "claude",
        "Claude",
        "claude-agent-acp",
        "npm install -g @agentclientprotocol/claude-agent-acp",
    ),
    (
        "codex",
        "Codex",
        "codex-acp",
        "npm install -g @agentclientprotocol/codex-acp",
    ),
    // OpenCode's ACP mode is a subcommand of its main binary (`opencode acp`),
    // so the adapter command IS `opencode` — matching the gateway preset.
    (
        "opencode",
        "OpenCode",
        "opencode",
        "npm install -g opencode-ai",
    ),
    // No ACP adapter exists for Gemini yet; empty command → never "installed"
    // (the plain `gemini` CLI is NOT an ACP adapter), shown as unavailable.
    ("gemini", "Gemini", "", ""),
];

#[derive(Debug, Clone, Serialize)]
pub struct DetectedAgent {
    pub key: String,
    pub label: String,
    /// The config `adapter.command` this agent uses.
    pub command: String,
    pub installed: bool,
    /// Absolute path when installed (bake this into the config).
    pub path: Option<String>,
    /// Whether a one-click install is available.
    pub installable: bool,
}

/// Which known ACP agents are installed on this machine (login-PATH lookup), so
/// the config form can offer the user's own agents as icons + a one-click
/// install for the rest.
#[tauri::command]
pub fn detect_agents() -> Vec<DetectedAgent> {
    KNOWN_AGENTS
        .iter()
        .map(|(key, label, cmd, install)| {
            // Resolve exactly the command the gateway preset writes — no
            // per-agent aliasing. A fallback here would report "installed" for
            // a command `absolutize_adapter_command` then fails to resolve,
            // and onboarding's pre-flight check would wave through a config
            // that can't start. An empty command (gemini) never resolves.
            let path = if cmd.is_empty() {
                None
            } else {
                resolve_on_login_path(cmd)
            };
            DetectedAgent {
                key: (*key).into(),
                label: (*label).into(),
                command: (*cmd).into(),
                installed: path.is_some(),
                path: path.map(|p| p.to_string_lossy().into_owned()),
                installable: !install.is_empty(),
            }
        })
        .collect()
}

/// One-click install of a known agent's ACP package (npm etc.). Runs the
/// hardcoded install command through the login shell (which has npm on PATH).
/// Long-running, so it's offloaded to a blocking thread.
#[tauri::command]
pub async fn install_agent(key: String) -> Result<String, String> {
    let install = KNOWN_AGENTS
        .iter()
        .find(|(k, _, _, _)| *k == key)
        .map(|(_, _, _, i)| *i)
        .ok_or("unknown agent")?;
    if install.is_empty() {
        return Err("no one-click installer is available for this agent".into());
    }
    let install = install.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let out = std::process::Command::new(&shell)
            .args(["-lic", &install])
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok("installed".to_string())
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(format!(
                "install failed — {}",
                err.trim().lines().last().unwrap_or("see terminal")
            ))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The npm package an agent's install command installs, if any
/// ("npm install -g <pkg>" -> <pkg>). Non-npm or empty installers -> None.
fn npm_package_of(install: &str) -> Option<&str> {
    install
        .strip_prefix("npm install -g ")
        .and_then(|rest| rest.split_whitespace().next())
}

/// Compare dotted release versions by their numeric [major, minor, patch] core
/// ("1.2.10" newer than "1.2.9"). Prerelease/build suffixes are ignored for
/// ordering — enough to decide "reinstall to latest". True when `latest` is
/// strictly newer than `installed`.
fn version_is_newer(installed: &str, latest: &str) -> bool {
    let core = |v: &str| -> Vec<u64> {
        let mut out: Vec<u64> = v
            .trim()
            .trim_start_matches('v')
            .split('.')
            .take(3)
            .map(|seg| {
                seg.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse::<u64>()
                    .unwrap_or(0)
            })
            .collect();
        out.resize(3, 0);
        out
    };
    core(latest) > core(installed)
}

/// Installed global versions for the given npm packages, in one shot
/// (`npm ls -g --depth=0 --json <pkg...>`). Missing packages are absent from the
/// map. Package names are KNOWN_AGENTS constants — never user input — so
/// interpolating them into the login-shell command can't inject.
fn npm_global_versions(pkgs: &[&str]) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    if pkgs.is_empty() {
        return map;
    }
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let cmd = format!("npm ls -g --depth=0 --json {}", pkgs.join(" "));
    // `npm ls` exits non-zero when a queried package is missing but still emits
    // the JSON tree on stdout, so parse stdout regardless of exit status.
    let Ok(out) = std::process::Command::new(&shell)
        .args(["-lic", &cmd])
        .output()
    else {
        return map;
    };
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
        return map;
    };
    if let Some(deps) = json.get("dependencies").and_then(|d| d.as_object()) {
        for (name, info) in deps {
            if let Some(ver) = info.get("version").and_then(|v| v.as_str()) {
                map.insert(name.clone(), ver.to_string());
            }
        }
    }
    map
}

/// Latest published version of `pkg` (`npm view <pkg> version`), or None when
/// offline / not found. `pkg` is a KNOWN_AGENTS constant.
fn npm_latest_version(pkg: &str) -> Option<String> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = std::process::Command::new(&shell)
        .args(["-lic", &format!("npm view {pkg} version")])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!v.is_empty()).then_some(v)
}

/// Per-agent update status for the ACP adapters that have an npm installer.
/// Field names follow the γ1↔γ2 shared contract (`installed`/`latest`/
/// `outdated`); `package` is additive.
#[derive(Debug, Clone, Serialize)]
pub struct AgentUpdate {
    pub key: String,
    pub label: String,
    pub package: String,
    /// Installed global version, or None when the package isn't installed.
    pub installed: Option<String>,
    /// Latest published version, or None when offline / not queried.
    pub latest: Option<String>,
    pub outdated: bool,
}

/// Check installed vs latest versions of the known ACP adapter npm packages so
/// the connector UI can offer a one-click upgrade. Reads installed versions in a
/// single `npm ls` and the latest of each INSTALLED package via `npm view`
/// (skipping the network for adapters that aren't installed). Long-running
/// (network), so it runs on a blocking thread. Upgrading reuses `install_agent`
/// (`npm install -g <pkg>` reinstalls to latest).
#[tauri::command]
pub async fn check_agent_updates() -> Result<Vec<AgentUpdate>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let pkgs: Vec<&str> = KNOWN_AGENTS
            .iter()
            .filter_map(|(_, _, _, install)| npm_package_of(install))
            .collect();
        let installed = npm_global_versions(&pkgs);
        KNOWN_AGENTS
            .iter()
            .filter_map(|(key, label, _cmd, install)| {
                let pkg = npm_package_of(install)?;
                let installed_version = installed.get(pkg).cloned();
                // Only hit the network for packages that are actually installed.
                let latest_version = installed_version
                    .as_ref()
                    .and_then(|_| npm_latest_version(pkg));
                let outdated = match (&installed_version, &latest_version) {
                    (Some(i), Some(l)) => version_is_newer(i, l),
                    _ => false,
                };
                Some(AgentUpdate {
                    key: (*key).into(),
                    label: (*label).into(),
                    package: pkg.into(),
                    installed: installed_version,
                    latest: latest_version,
                    outdated,
                })
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Find an executable named `cmd` on the login PATH → absolute path. `pub(crate)`
/// so changes.rs can locate `gh` for the open-PR flow (a GUI-launched app has a
/// minimal PATH that doesn't include homebrew/npm bins).
pub(crate) fn resolve_on_login_path(cmd: &str) -> Option<PathBuf> {
    for dir in login_path_dirs() {
        let candidate = dir.join(cmd);
        if candidate.is_file() {
            // Executable bit check (best-effort).
            let exec = fs::metadata(&candidate)
                .map(|m| std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o111 != 0)
                .unwrap_or(true);
            if exec {
                return candidate.canonicalize().ok().or(Some(candidate));
            }
        }
    }
    None
}

/// Rewrite the config's `adapter.command` to an absolute path when it's bare —
/// a GUI-spawned daemon has a minimal PATH, so the connector's load-time
/// `command -v` check fails on `opencode-acp`/`claude-agent-acp` etc. Mirrors
/// install.sh's resolution. Errors clearly when the adapter isn't installed.
fn normalize_adapter_launcher(config_toml: &str) -> Result<String, String> {
    // Read the current command value (robust extraction via the parsed TOML).
    let cfg: toml::Value = toml::from_str(config_toml).map_err(|e| e.to_string())?;
    let cmd = cfg
        .get("accounts")
        .and_then(|a| a.as_table())
        .and_then(|t| t.values().next()) // one account per generated config
        .and_then(|acct| acct.get("adapter"))
        .and_then(|ad| ad.get("command"))
        .and_then(|c| c.as_str());
    let Some(cmd) = cmd else {
        return Ok(config_toml.to_string()); // no adapter command — leave as-is
    };
    let command = if Path::new(cmd).is_absolute() {
        PathBuf::from(cmd)
    } else {
        resolve_on_login_path(cmd).ok_or_else(|| {
            format!(
                "agent adapter '{cmd}' isn't installed (or not on your login PATH). \
             Install it — e.g. Claude: npm i -g @agentclientprotocol/claude-agent-acp — \
             then set it up again, or pick a different agent."
            )
        })?
    };

    // npm's `codex-acp` executable is commonly a symlink to a JavaScript file
    // beginning `#!/usr/bin/env node`. The connector deliberately starts agents
    // with a restricted environment, so that shebang cannot find `node` even
    // though the desktop's login shell can. Invoke Node by its resolved absolute
    // path and make the script its first argument instead.
    let is_env_node_script = fs::read_to_string(&command)
        .ok()
        .and_then(|content| content.lines().next().map(str::to_owned))
        .is_some_and(|first| first.trim() == "#!/usr/bin/env node");

    let mut doc: toml_edit::DocumentMut = config_toml
        .parse()
        .map_err(|e: toml_edit::TomlError| e.to_string())?;
    let account_id = doc
        .get("accounts")
        .and_then(|a| a.as_table())
        .and_then(|a| a.iter().next().map(|(id, _)| id.to_string()))
        .ok_or("config has no account")?;
    let adapter = &mut doc["accounts"][account_id.as_str()]["adapter"];
    use toml_edit::{value, Array};
    if is_env_node_script {
        let node = resolve_on_login_path("node").ok_or(
            "Node.js is required to launch this ACP adapter but was not found on the login PATH",
        )?;
        let mut args = adapter["args"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let script = command.to_string_lossy().into_owned();
        if args.first() != Some(&script) {
            args.insert(0, script);
        }
        let mut array = Array::new();
        for arg in args {
            array.push(arg.as_str());
        }
        adapter["command"] = value(node.to_string_lossy().as_ref());
        adapter["args"] = value(array);
    } else {
        adapter["command"] = value(command.to_string_lossy().as_ref());
    }
    Ok(doc.to_string())
}

/// Write a gateway-generated connector config + its token to `~/.cheers/`, the
/// way `install.sh` does — the "configure via form" path. The gateway's
/// `POST /enrollment/redeem` returns a ready `config_toml` (which references a
/// `token_file`), the plaintext `token`, and that relative `token_file` path;
/// this lands both on disk so the instance can start with NO hand-editing.
/// The adapter command is resolved to an absolute path (GUI PATH is minimal).
/// Returns the config path for `connector_start`.
#[tauri::command]
pub fn connector_write_onboarded(
    account_id: String,
    config_toml: String,
    token: String,
    token_file: String,
) -> Result<String, String> {
    // Resolve the adapter to an absolute path BEFORE writing (and error early
    // if it isn't installed, so we don't leave a crash-looping config behind).
    let config_toml = normalize_adapter_launcher(&config_toml)?;

    let base = dirs::home_dir()
        .map(|h| h.join(".cheers"))
        .ok_or("no home directory")?;
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;

    // account_id forms the config filename — it must be a plain label, never a
    // path. token_file is gateway-chosen ("secrets/<id>.token"): keep it
    // relative and confine it under ~/.cheers/ (no absolute, no `..`).
    let safe_id = safe_name(&account_id);
    let tf = PathBuf::from(&token_file);
    if tf.is_absolute()
        || tf
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("invalid token_file path".into());
    }
    let token_path = base.join(&tf);
    if let Some(parent) = token_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&token_path, token.trim().as_bytes()).map_err(|e| e.to_string())?;
    // Tokens are secrets: 0600, like install.sh.
    let _ = fs::set_permissions(
        &token_path,
        std::os::unix::fs::PermissionsExt::from_mode(0o600),
    );

    let config_path = base.join(format!("cheers-daemon.{safe_id}.toml"));
    fs::write(&config_path, config_toml.as_bytes()).map_err(|e| e.to_string())?;

    // Zero-prep: the connector validates that every policy.workspace root exists
    // at startup (resolve_existing_dirs), and the gateway's default config points
    // at ~/.cheers/workspace/<bot>, which nothing else creates — so onboarding
    // from the desktop would fail on a fresh machine. We're on the same box and
    // own ~/.cheers, so create the referenced workspace dirs now.
    ensure_workspace_dirs(&config_toml);

    Ok(config_path.to_string_lossy().into_owned())
}

/// Create the workspace directories a freshly-onboarded config references so a
/// desktop-started connector needs no manual prep. Best-effort (a dir that can't
/// be created just resurfaces the connector's own clear startup error) and
/// SCOPED to the user's home dir — a gateway-supplied config must not be able to
/// make us `mkdir -p` arbitrary system paths.
fn ensure_workspace_dirs(config_toml: &str) {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    for p in workspace_dirs_in_config(config_toml, &home) {
        let _ = fs::create_dir_all(&p);
    }
}

/// Read a config off disk and ensure its workspace dirs exist. Called before
/// every start/restart so a daemon that never wrote `daemon.json` (crashed, or
/// started from an existing `.toml` we didn't onboard) still gets zero-prep.
fn ensure_workspace_dirs_at(config_path: &Path) {
    if let Ok(content) = fs::read_to_string(config_path) {
        ensure_workspace_dirs(&content);
    }
}

/// The config path for a connector by name, so `restart` can carry `--config`
/// even before any `daemon.json` exists — the CLI's restart fails with "restart
/// requires --config" when there is no prior metadata, which is exactly the case
/// right after onboarding or after a crash. Prefers the daemon's recorded config
/// (covers arbitrary "existing .toml" starts), then the desktop's onboarded
/// location `~/.cheers/cheers-daemon.<safe>.toml`.
fn config_path_for(name: &str) -> Option<PathBuf> {
    if let Some(meta) = read_metadata_by_name(name) {
        return Some(meta.config_path);
    }
    let p = dirs::home_dir()?
        .join(".cheers")
        .join(format!("cheers-daemon.{}.toml", safe_name(name)));
    p.exists().then_some(p)
}

/// The every-account `policy.workspace` roots + `default_cwd` in a config,
/// tilde-expanded and kept only when under `home`. Pure (no I/O) so the
/// home-scoping is unit-testable. Malformed TOML / missing keys → empty.
fn workspace_dirs_in_config(config_toml: &str, home: &Path) -> Vec<PathBuf> {
    let Ok(doc) = config_toml.parse::<toml::Value>() else {
        return Vec::new();
    };
    let Some(accounts) = doc.get("accounts").and_then(toml::Value::as_table) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for acct in accounts.values() {
        let Some(ws) = acct.get("policy").and_then(|p| p.get("workspace")) else {
            continue;
        };
        let roots = ws
            .get("allowed_roots")
            .and_then(toml::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(toml::Value::as_str);
        let default_cwd = ws.get("default_cwd").and_then(toml::Value::as_str);
        for raw in roots.chain(default_cwd) {
            let p = expand_tilde(raw);
            if p.starts_with(home) {
                out.push(p);
            }
        }
    }
    out
}

/// A config the desktop may start: an existing `.toml` under `~/.cheers/`.
fn guard_startable_config(path: &str) -> Result<(), String> {
    let canon = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "config file does not exist".to_string())?;
    if canon.extension().and_then(|e| e.to_str()) != Some("toml") {
        return Err("config must be a .toml file".into());
    }
    let cheers_dir = dirs::home_dir()
        .map(|h| h.join(".cheers"))
        .ok_or("no home directory")?;
    if !canon.starts_with(&cheers_dir) {
        return Err("config must live under ~/.cheers/".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn connector_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, SupervisorState>,
    name: String,
) -> Result<String, String> {
    // Deliberate stop: the supervisor must not fight the user.
    state.managed.lock().unwrap().remove(&name);
    run_cli(&app, &["--name", &name, "stop"]).await
}

#[tauri::command]
pub async fn connector_restart(
    app: tauri::AppHandle,
    state: tauri::State<'_, SupervisorState>,
    name: String,
) -> Result<String, String> {
    // Carry --config so restart works even with no prior daemon.json (fresh
    // onboard / after a crash), and create the workspace dirs first.
    let out = match config_path_for(&name) {
        Some(cfg) => {
            ensure_workspace_dirs_at(&cfg);
            let cfg = cfg.to_string_lossy().into_owned();
            run_cli(&app, &["--name", &name, "--config", &cfg, "restart"]).await?
        }
        None => run_cli(&app, &["--name", &name, "restart"]).await?,
    };
    state.managed.lock().unwrap().insert(name);
    Ok(out)
}

/// Remove a LOCAL connector instance: stop it, delete its service directory
/// (daemon.json + logs), drop it from supervisor/start-with-app state, and —
/// when `delete_config` is set — delete its config TOML too (only if that
/// config lives under `~/.cheers/`). This removes the local daemon only; the
/// bot account on the gateway is unaffected (delete that from the web Bots UI).
#[tauri::command]
pub async fn connector_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, SupervisorState>,
    name: String,
    delete_config: bool,
) -> Result<(), String> {
    // Capture the config path before we remove the service dir that records it.
    let config_path = read_metadata_by_name(&name).map(|m| m.config_path);

    // Forget it from the supervisor BEFORE stopping: the supervisor loop takes
    // a one-shot `managed` snapshot each tick, and a still-queued revive would
    // `start_daemon` → recreate the service dir + daemon.json right after we
    // delete them (the "delete sometimes resurrects" race). Removing first
    // closes the window — the stop below kills any already-running process.
    state.managed.lock().unwrap().remove(&name);
    {
        let mut settings = load_settings();
        if settings.start_with_app.remove(&name) {
            let _ = save_settings(&settings);
        }
    }

    // Best-effort stop; a dead/never-started instance has nothing to stop.
    let _ = run_cli(&app, &["--name", &name, "stop"]).await;

    // Remove the service directory (state + logs). safe_name matches the
    // sanitized on-disk directory the connector created.
    if let Some(home) = connector_home() {
        let service_dir = home.join(safe_name(&name));
        if service_dir.is_dir() {
            fs::remove_dir_all(&service_dir).map_err(|e| e.to_string())?;
        }
    }

    // Optionally delete the config file — but only within ~/.cheers/, never an
    // arbitrary path a stale daemon.json might reference.
    if delete_config {
        if let Some(cfg) = config_path {
            let under_cheers = cfg
                .canonicalize()
                .ok()
                .zip(dirs::home_dir().map(|h| h.join(".cheers")))
                .map(|(c, base)| c.starts_with(&base))
                .unwrap_or(false);
            if under_cheers {
                let _ = fs::remove_file(&cfg);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn connector_logs(
    app: tauri::AppHandle,
    name: String,
    lines: u32,
) -> Result<String, String> {
    run_cli(
        &app,
        &["--name", &name, "--lines", &lines.to_string(), "logs"],
    )
    .await
}

#[tauri::command]
pub fn connector_read_config(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    guard_config_path(&p)?;
    fs::read_to_string(&p).map_err(|e| e.to_string())
}

/// The subset of a connector config the form edits — the high-value settings
/// for one account, with everything else left untouched in the file. Read via
/// [`connector_config_read_fields`], written back with [`connector_config_write_fields`]
/// (structure-preserving, so comments and unlisted keys survive).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigFields {
    pub account_id: String,
    // ── important ──
    pub adapter_command: String,
    pub adapter_args: Vec<String>,
    pub allowed_roots: Vec<String>,
    pub default_cwd: Option<String>,
    /// permission.auto_allow — approve tool calls without asking.
    pub auto_allow: bool,
    // ── more ──
    pub env_inherit: bool,
    pub env_allow: Vec<String>,
    pub forward_to_backend: bool,
    pub wait_timeout_ms: i64,
    pub on_timeout: String,
    pub max_concurrent: i64,
    pub max_duration_ms: i64,
    pub heartbeat_interval_ms: i64,
    pub file_upload_allow: bool,
}

/// Read the form-editable fields of the (first) account in a config, falling
/// back to the connector's documented defaults for anything unset.
#[tauri::command]
pub fn connector_config_read_fields(path: String) -> Result<ConfigFields, String> {
    let p = PathBuf::from(&path);
    guard_config_path(&p)?;
    let text = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let cfg: toml::Value = toml::from_str(&text).map_err(|e| e.to_string())?;
    let accounts = cfg
        .get("accounts")
        .and_then(|a| a.as_table())
        .ok_or("config has no [accounts]")?;
    let (account_id, acct) = accounts.iter().next().ok_or("config has no account")?;

    let s = |t: Option<&toml::Value>, k: &str| {
        t.and_then(|v| v.get(k))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    let arr = |t: Option<&toml::Value>, k: &str| -> Vec<String> {
        t.and_then(|v| v.get(k))
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    let boolean = |t: Option<&toml::Value>, k: &str, default: bool| {
        t.and_then(|v| v.get(k))
            .and_then(|v| v.as_bool())
            .unwrap_or(default)
    };
    let int = |t: Option<&toml::Value>, k: &str, default: i64| {
        t.and_then(|v| v.get(k))
            .and_then(|v| v.as_integer())
            .unwrap_or(default)
    };

    let adapter = acct.get("adapter");
    let policy = acct.get("policy");
    let pol = |name: &str| policy.and_then(|p| p.get(name));
    let ws = pol("workspace");
    let perm = pol("permission");
    let env = pol("env");
    let prompt = pol("prompt");
    let file_upload = pol("file_upload");
    let bridge = acct.get("bridge");

    Ok(ConfigFields {
        account_id: account_id.clone(),
        adapter_command: s(adapter, "command").unwrap_or_default(),
        adapter_args: arr(adapter, "args"),
        allowed_roots: arr(ws, "allowed_roots"),
        default_cwd: s(ws, "default_cwd"),
        auto_allow: boolean(perm, "auto_allow", false),
        env_inherit: boolean(env, "inherit", false),
        env_allow: arr(env, "allow"),
        forward_to_backend: boolean(perm, "forward_to_backend", true),
        wait_timeout_ms: int(perm, "wait_timeout_ms", 900_000),
        on_timeout: s(perm, "on_timeout").unwrap_or_else(|| "cancel".into()),
        max_concurrent: int(prompt, "max_concurrent", 1),
        max_duration_ms: int(prompt, "max_duration_ms", 900_000),
        heartbeat_interval_ms: int(bridge, "heartbeat_interval_ms", 25_000),
        file_upload_allow: boolean(file_upload, "allow", false),
    })
}

/// Apply the form fields back into the config, preserving comments and any keys
/// the form doesn't manage (toml_edit). A bare adapter command is resolved to
/// an absolute path when possible (GUI PATH is minimal), same as onboarding.
#[tauri::command]
pub fn connector_config_write_fields(path: String, fields: ConfigFields) -> Result<(), String> {
    let p = PathBuf::from(&path);
    guard_config_path(&p)?;
    let text = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut doc: toml_edit::DocumentMut = text
        .parse()
        .map_err(|e: toml_edit::TomlError| e.to_string())?;

    let id = &fields.account_id;
    if doc.get("accounts").and_then(|a| a.get(id)).is_none() {
        return Err("account not found in config".into());
    }

    use toml_edit::{value, Array};
    let str_array = |items: &[String]| {
        let mut a = Array::new();
        for it in items {
            a.push(it.as_str());
        }
        a
    };

    // Adapter: best-effort absolutize a bare command.
    let cmd = if Path::new(&fields.adapter_command).is_absolute() {
        fields.adapter_command.clone()
    } else {
        resolve_on_login_path(&fields.adapter_command)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| fields.adapter_command.clone())
    };
    doc["accounts"][id]["adapter"]["command"] = value(cmd);
    doc["accounts"][id]["adapter"]["args"] = value(str_array(&fields.adapter_args));

    // Workspace roots (drop default_cwd when cleared).
    doc["accounts"][id]["policy"]["workspace"]["allowed_roots"] =
        value(str_array(&fields.allowed_roots));
    match fields
        .default_cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(cwd) => doc["accounts"][id]["policy"]["workspace"]["default_cwd"] = value(cwd),
        None => {
            if let Some(t) = doc["accounts"][id]["policy"]["workspace"].as_table_mut() {
                t.remove("default_cwd");
            }
        }
    }

    // Permission.
    doc["accounts"][id]["policy"]["permission"]["auto_allow"] = value(fields.auto_allow);
    doc["accounts"][id]["policy"]["permission"]["forward_to_backend"] =
        value(fields.forward_to_backend);
    doc["accounts"][id]["policy"]["permission"]["wait_timeout_ms"] = value(fields.wait_timeout_ms);
    doc["accounts"][id]["policy"]["permission"]["on_timeout"] = value(fields.on_timeout.as_str());

    // Env.
    doc["accounts"][id]["policy"]["env"]["inherit"] = value(fields.env_inherit);
    doc["accounts"][id]["policy"]["env"]["allow"] = value(str_array(&fields.env_allow));

    // Prompt.
    doc["accounts"][id]["policy"]["prompt"]["max_concurrent"] = value(fields.max_concurrent);
    doc["accounts"][id]["policy"]["prompt"]["max_duration_ms"] = value(fields.max_duration_ms);

    // Bridge + file upload.
    doc["accounts"][id]["bridge"]["heartbeat_interval_ms"] = value(fields.heartbeat_interval_ms);
    doc["accounts"][id]["policy"]["file_upload"]["allow"] = value(fields.file_upload_allow);

    let normalized = normalize_adapter_launcher(&doc.to_string())?;
    fs::write(&p, normalized).map_err(|e| e.to_string())
}

/// Mirror the connector's startup check (`config.rs`: when `allowed_roots` is
/// non-empty, `default_cwd` must be under one of them) so the form can warn
/// BEFORE saving — the daemon's own check only fires on restart, by which point
/// the user has already seen a wall of "stream closed" errors. Expands `~` via
/// the real home dir and canonicalizes when the path exists, so the result
/// matches what the daemon will see. Pure (no I/O beyond `canonicalize`) so the
/// home-scoping is unit-testable. Returns true when valid OR when we can't be
/// sure (non-existent path) — the daemon's check is authoritative, this is a
/// UX hint.
fn workspace_cwd_allowed(default_cwd: &str, allowed_roots: &[String]) -> bool {
    if allowed_roots.is_empty() {
        return true; // no restriction until the user adds a root
    }
    let home = dirs::home_dir();
    let expand = |raw: &str| -> PathBuf {
        let p = if raw == "~" {
            home.clone().unwrap_or_default()
        } else if let Some(rest) = raw.strip_prefix("~/") {
            home.clone().map(|h| h.join(rest)).unwrap_or_default()
        } else {
            PathBuf::from(raw)
        };
        // Canonicalize when the dir exists (matches the daemon); otherwise fall
        // back to the expanded path so a not-yet-created dir still compares.
        p.canonicalize().unwrap_or(p)
    };
    let cwd = expand(default_cwd);
    allowed_roots.iter().any(|root| cwd.starts_with(expand(root)))
}

/// Validate the workspace fields the way the connector does at startup, so the
/// form can surface "default_cwd must be under allowed_roots" inline instead of
/// as a post-restart daemon crash. Returns `{ cwd_under_root: bool }`.
#[tauri::command]
pub fn connector_validate_workspace(
    default_cwd: Option<String>,
    allowed_roots: Vec<String>,
) -> bool {
    match default_cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(cwd) => workspace_cwd_allowed(cwd, &allowed_roots),
        None => true, // no cwd set — nothing to validate
    }
}

/// Drag-to-grant (A3): append one or more absolute directory paths to the
/// (first) account's `allowed_roots`, reusing the same guard + structure-
/// preserving `toml_edit` write path as [`connector_config_write_fields`]
/// (comments / other keys survive). The config is resolved from the instance's
/// own daemon.json — never a webview-supplied path. Non-directories and
/// already-present roots are skipped; when running, the daemon is restarted so
/// the new root takes effect. This only WIDENS where a LOCAL agent may work —
/// identical in effect to hand-editing the config; the gateway still owns every
/// message and permission DECISION.
#[tauri::command]
pub async fn connector_add_allowed_roots(
    app: tauri::AppHandle,
    state: tauri::State<'_, SupervisorState>,
    name: String,
    roots: Vec<String>,
) -> Result<(), String> {
    let meta = read_metadata_by_name(&name).ok_or("connector not found")?;
    let p = meta.config_path.clone();
    guard_config_path(&p)?;
    let text = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut doc: toml_edit::DocumentMut = text
        .parse()
        .map_err(|e: toml_edit::TomlError| e.to_string())?;

    // First (only) account — same convention as the other config commands.
    let acct_id = doc
        .get("accounts")
        .and_then(|a| a.as_table())
        .and_then(|t| t.iter().next().map(|(k, _)| k.to_string()))
        .ok_or("config has no account")?;

    // Existing roots (to dedup against).
    let mut merged: Vec<String> = doc["accounts"][acct_id.as_str()]["policy"]["workspace"]
        ["allowed_roots"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let mut added: Vec<String> = Vec::new();
    for raw in roots {
        // Only real directories on THIS machine become roots; Finder can drop
        // files too. Canonicalize so symlinks / `..` don't produce a dup.
        let canon = match PathBuf::from(&raw).canonicalize() {
            Ok(c) if c.is_dir() => c,
            _ => continue,
        };
        let s = canon.to_string_lossy().into_owned();
        if merged.iter().any(|e| e == &s) || added.contains(&s) {
            continue;
        }
        added.push(s);
    }
    if added.is_empty() {
        return Ok(()); // all dupes or non-dirs — leave the file untouched
    }
    merged.extend(added.iter().cloned());

    use toml_edit::{value, Array};
    let mut arr = Array::new();
    for it in &merged {
        arr.push(it.as_str());
    }
    doc["accounts"][acct_id.as_str()]["policy"]["workspace"]["allowed_roots"] = value(arr);
    fs::write(&p, doc.to_string()).map_err(|e| e.to_string())?;

    // Restart only a currently-running daemon so the new root takes effect; a
    // deliberately-stopped instance stays stopped (it picks the root up on its
    // next start).
    if pid_alive(meta.pid) {
        ensure_workspace_dirs_at(&p);
        let cfg = p.to_string_lossy().into_owned();
        if run_cli(&app, &["--name", &name, "--config", &cfg, "restart"])
            .await
            .is_ok()
        {
            state.managed.lock().unwrap().insert(name);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn connector_write_config(path: String, content: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    guard_config_path(&p)?;
    // Parse before writing: a syntactically broken TOML would take the
    // connector down on its next restart with no UI feedback.
    toml::from_str::<toml::Value>(&content).map_err(|e| format!("invalid TOML: {e}"))?;
    fs::write(&p, content).map_err(|e| e.to_string())
}

/// The config editor may only touch a config that a discovered connector
/// instance actually references (`daemon.json.config_path`). The webview
/// renders remote-server content and can call these commands, so an unscoped
/// "any absolute .toml" would be an arbitrary-file read/write primitive
/// (`~/.aws/*` exfiltration, `~/.cargo/config.toml` RCE). Canonicalize both
/// sides so symlinks/`..` can't escape the allowlist.
fn guard_config_path(p: &Path) -> Result<(), String> {
    let want = p
        .canonicalize()
        .map_err(|_| "config file does not exist".to_string())?;
    if known_config_paths().contains(&want) || is_desktop_onboarded_config(&want) {
        Ok(())
    } else {
        Err("not a known connector config".into())
    }
}

/// A desktop-created connector is formally recoverable from its generated
/// `~/.cheers/cheers-daemon.<safe-name>.toml` even before the daemon has written
/// metadata. This is a narrowly scoped recovery contract, not an arbitrary TOML
/// allowlist: the file must be a direct child of the desktop-owned home and use
/// the exact onboarding filename grammar.
fn is_desktop_onboarded_config(path: &Path) -> bool {
    let Some(home) = dirs::home_dir().map(|h| h.join(".cheers")) else {
        return false;
    };
    if path.parent() != Some(home.as_path()) {
        return false;
    }
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("cheers-daemon."))
        .and_then(|name| name.strip_suffix(".toml"))
        .is_some_and(|name| !name.is_empty() && safe_name(name) == name)
}

/// Canonical paths of every config referenced by a discovered `daemon.json`.
fn known_config_paths() -> std::collections::HashSet<PathBuf> {
    let mut out = std::collections::HashSet::new();
    let Some(home) = connector_home() else {
        return out;
    };
    let Ok(entries) = fs::read_dir(&home) else {
        return out;
    };
    for entry in entries.flatten() {
        let meta: Option<DaemonMetadata> = fs::read_to_string(entry.path().join("daemon.json"))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok());
        if let Some(m) = meta {
            if let Ok(canon) = m.config_path.canonicalize() {
                out.insert(canon);
            }
        }
    }
    out
}

/// Expand a leading `~` / `~/` to the home dir — connector configs write roots
/// like `~/Projects`, which are shell-relative, not filesystem paths.
fn expand_tilde(s: &str) -> PathBuf {
    if let Some(rest) = s.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    } else if s == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    PathBuf::from(s)
}

/// One account's workspace policy, parsed from a connector config TOML.
struct AccountWorkspace {
    /// Configured roots (`default_cwd` + `allowed_roots`), tilde-expanded, raw.
    roots: Vec<String>,
    /// `bridge.control_url` — which gateway this account dials (host filter).
    control_url: Option<String>,
}

/// Parse `[accounts.<id>...]` blocks from a config TOML. A single daemon config
/// hosts MANY accounts; each has its own `policy.workspace` and `bridge`.
/// (The `<id>` is a local label, not the gateway bot UUID.)
fn parse_config_accounts(config_path: &Path) -> Vec<AccountWorkspace> {
    let Ok(text) = fs::read_to_string(config_path) else {
        return Vec::new();
    };
    let Ok(cfg) = toml::from_str::<toml::Value>(&text) else {
        return Vec::new();
    };
    let Some(accounts) = cfg.get("accounts").and_then(|a| a.as_table()) else {
        return Vec::new();
    };
    accounts
        .values()
        .map(|acct| {
            let ws = acct.get("policy").and_then(|p| p.get("workspace"));
            let mut roots = Vec::new();
            if let Some(dc) = ws
                .and_then(|w| w.get("default_cwd"))
                .and_then(|v| v.as_str())
            {
                roots.push(dc.to_string());
            }
            if let Some(arr) = ws
                .and_then(|w| w.get("allowed_roots"))
                .and_then(|v| v.as_array())
            {
                roots.extend(arr.iter().filter_map(|v| v.as_str().map(str::to_string)));
            }
            let control_url = acct
                .get("bridge")
                .and_then(|b| b.get("control_url"))
                .and_then(|v| v.as_str())
                .map(str::to_string);
            AccountWorkspace { roots, control_url }
        })
        .collect()
}

/// host:port of a ws(s)/http(s) URL, for comparing a connector's control_url
/// against the server the desktop is pointed at (scheme-insensitive).
fn url_authority(url: &str) -> Option<String> {
    let after = url.split("://").nth(1)?;
    Some(after.split(['/', '?']).next()?.to_ascii_lowercase())
}

/// Resolve the local workspace directories for an instance: the daemon cwd
/// (daemon.json) plus its accounts' `allowed_roots` / `default_cwd`. Only
/// existing directories are returned. Same-machine value the web app can't
/// provide — these paths are on THIS box.
#[tauri::command]
pub fn connector_roots(name: String) -> Result<ConnectorRoots, String> {
    // Resolve the instance by its daemon.json `name` (the service-dir name is a
    // sanitized form of it, which we don't reproduce here).
    let meta: Option<DaemonMetadata> = read_metadata_by_name(&name);
    let mut roots = ConnectorRoots::default();
    let mut seen = std::collections::HashSet::new();
    let push_dir =
        |raw: &str, out: &mut Vec<String>, seen: &mut std::collections::HashSet<String>| {
            let p = expand_tilde(raw);
            if p.is_dir() {
                if let Some(s) = p.to_str() {
                    if seen.insert(s.to_string()) {
                        out.push(s.to_string());
                    }
                }
            }
        };
    if let Some(m) = &meta {
        if let Some(cwd) = &m.cwd {
            if cwd.is_dir() {
                let s = cwd.to_string_lossy().into_owned();
                seen.insert(s.clone());
                roots.cwd = Some(s);
            }
        }
        for acct in parse_config_accounts(&m.config_path) {
            for raw in acct.roots {
                push_dir(&raw, &mut roots.roots, &mut seen);
            }
        }
    }
    Ok(roots)
}

/// The union of workspace roots served by ANY local connector (all daemon
/// configs, all accounts), tilde-expanded and canonicalized to existing dirs.
/// When `server` is given, only accounts whose `control_url` targets that
/// gateway count — the RemoteWorkspace browse is scoped to the desktop's
/// server, so a local connector pointed elsewhere isn't the same bot.
fn all_local_roots(server: Option<&str>) -> Vec<PathBuf> {
    let want_authority = server.and_then(url_authority);
    let Some(home) = connector_home() else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&home) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry in entries.flatten() {
        let meta: Option<DaemonMetadata> = fs::read_to_string(entry.path().join("daemon.json"))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok());
        let Some(m) = meta else { continue };
        for acct in parse_config_accounts(&m.config_path) {
            if let Some(want) = &want_authority {
                match acct.control_url.as_deref().and_then(url_authority) {
                    Some(a) if &a == want => {}
                    _ => continue,
                }
            }
            for raw in acct.roots {
                if let Ok(canon) = expand_tilde(&raw).canonicalize() {
                    if canon.is_dir() && seen.insert(canon.clone()) {
                        out.push(canon);
                    }
                }
            }
        }
    }
    out
}

/// Is `path` (a file or directory, as the gateway reported the connector's
/// path) physically present on THIS machine INSIDE a workspace root served by
/// a local connector pointed at `server`? Drives the "open in place vs
/// download" choice. Forward containment ONLY: `path` must live under a served
/// root. (An earlier reverse check also matched any ANCESTOR of a served root,
/// so a sibling path read as local — wrong; callers pass the specific file
/// path, which must genuinely be inside a served root.)
#[tauri::command]
pub fn local_root_available(root: String, server: Option<String>) -> bool {
    let Ok(canon) = PathBuf::from(&root).canonicalize() else {
        return false;
    };
    all_local_roots(server.as_deref())
        .iter()
        .any(|r| canon.starts_with(r))
}

/// Open an absolute `path` from the remote-workspace browser in a local
/// `opener`, guarded to the union of local connector roots (NOT a single
/// instance) — the file the user is viewing may belong to any local bot.
#[tauri::command]
pub fn open_local_path(path: String, opener: String) -> Result<(), String> {
    let canon = PathBuf::from(&path)
        .canonicalize()
        .map_err(|_| "path does not exist locally".to_string())?;
    if !all_local_roots(None).iter().any(|r| canon.starts_with(r)) {
        return Err("path is not under any local connector workspace root".into());
    }
    run_opener(&opener, &canon)
}

/// Write a REMOTE workspace file's bytes to a local cache dir and open the
/// copy in `opener` — the "download then open" path for a file whose connector
/// is NOT on this machine. The copy is detached (edits don't sync back), which
/// the UI makes clear. `filename` is reduced to a safe basename, so the write
/// target is always `<cache>/cheers/opened/<basename>` — no traversal.
#[tauri::command]
pub fn open_remote_file(
    filename: String,
    content_b64: String,
    opener: String,
) -> Result<(), String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content_b64.trim())
        .map_err(|_| "file content was not valid base64".to_string())?;

    // Basename only: strip any directory components a remote name might carry.
    let base = Path::new(&filename)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && *s != "." && *s != "..")
        .unwrap_or("download");
    let base: String = base.chars().take(200).collect();

    let dir = dirs::cache_dir()
        .ok_or("no cache directory")?
        .join("cheers/opened");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(&base);
    fs::write(&target, &bytes).map_err(|e| e.to_string())?;
    // The bytes are gateway-supplied and the file may be revealed in Finder,
    // so mark it quarantined: Gatekeeper then guards double-click execution of
    // an `evil.command`/`.app`/etc. (editors, which just read it, are unaffected).
    let _ = std::process::Command::new("xattr")
        .args(["-w", "com.apple.quarantine", "0181;00000000;Cheers;"])
        .arg(&target)
        .status();
    run_opener(&opener, &target)
}

/// An app that can open a workspace directory. `finder` is always present;
/// editors are listed only when installed (detected by bundle id).
#[derive(Debug, Clone, Serialize)]
pub struct Opener {
    /// Stable key passed back to `open_path` (e.g. "finder", "vscode", "zed").
    pub key: String,
    pub label: String,
}

/// (key, label, macOS bundle id) for the editors we offer. Finder is handled
/// separately (reveal, not open-with). Add rows here to support more editors.
const KNOWN_EDITORS: &[(&str, &str, &str)] = &[
    ("vscode", "VS Code", "com.microsoft.VSCode"),
    ("cursor", "Cursor", "com.todesktop.230313mzl4w4u92"),
    ("zed", "Zed", "dev.zed.Zed"),
    ("webstorm", "WebStorm", "com.jetbrains.WebStorm"),
    ("pycharm", "PyCharm", "com.jetbrains.pycharm"),
    ("rustrover", "RustRover", "com.jetbrains.RustRover"),
    ("sublime", "Sublime Text", "com.sublimetext.4"),
];

/// Is an app with this bundle id installed? Spotlight knows without launching it.
fn bundle_installed(bundle_id: &str) -> bool {
    std::process::Command::new("mdfind")
        .arg(format!("kMDItemCFBundleIdentifier == '{bundle_id}'"))
        .output()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false)
}

fn editor_bundle(key: &str) -> Option<&'static str> {
    KNOWN_EDITORS
        .iter()
        .find(|(k, _, _)| *k == key)
        .map(|(_, _, id)| *id)
}

/// The openers available on this machine: always Finder, plus every installed
/// editor from KNOWN_EDITORS. The desktop UI renders one button per opener.
#[tauri::command]
pub fn available_openers() -> Vec<Opener> {
    let mut out = vec![Opener {
        key: "finder".into(),
        label: "Finder".into(),
    }];
    for (key, label, bundle_id) in KNOWN_EDITORS {
        if bundle_installed(bundle_id) {
            out.push(Opener {
                key: (*key).into(),
                label: (*label).into(),
            });
        }
    }
    out
}

/// Open an instance's workspace `path` in `opener` (Finder reveal, or an
/// editor by bundle id). Guarded to an existing absolute path under one of the
/// instance's configured roots — the desktop opens the agent's OWN directories,
/// never an arbitrary path the (remote-server-influenced) webview names.
#[tauri::command]
pub fn open_path(name: String, path: String, opener: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.is_absolute() {
        return Err("expected an absolute path".into());
    }
    let canon = target
        .canonicalize()
        .map_err(|_| "path does not exist".to_string())?;
    let roots = connector_roots(name)?;
    let allowed: Vec<PathBuf> = roots
        .cwd
        .into_iter()
        .chain(roots.roots)
        .filter_map(|r| PathBuf::from(r).canonicalize().ok())
        .collect();
    if !allowed.iter().any(|r| canon.starts_with(r)) {
        return Err("path is outside this connector's workspace roots".into());
    }
    run_opener(&opener, &canon)
}

/// Launch `open` for a validated (already canonicalized + guarded) path. The
/// path is a trailing OsString arg, never a shell string, so it can't inject
/// flags. Finder reveals (`-R`); editors open the folder/file by bundle id.
fn run_opener(opener: &str, canon: &Path) -> Result<(), String> {
    let mut cmd = std::process::Command::new("open");
    if opener == "finder" {
        cmd.arg("-R").arg(canon);
    } else if let Some(bundle_id) = editor_bundle(opener) {
        cmd.arg("-b").arg(bundle_id).arg(canon);
    } else {
        return Err(format!("unknown opener: {opener}"));
    }
    cmd.status().map_err(|e| e.to_string()).and_then(|s| {
        if s.success() {
            Ok(())
        } else {
            Err(format!("{opener} could not open the path"))
        }
    })
}

#[tauri::command]
pub fn connector_set_start_with_app(name: String, enabled: bool) -> Result<(), String> {
    let mut settings = load_settings();
    if enabled {
        settings.start_with_app.insert(name);
    } else {
        settings.start_with_app.remove(&name);
    }
    save_settings(&settings)
}

/// Boot + watch loop: launch every start-with-app instance, then poll every
/// 30s and revive managed instances whose process died (with a notification —
/// silent restarts hide real crash loops).
pub fn spawn_supervisor(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let boot = load_settings().start_with_app;
        {
            let state = app.state::<SupervisorState>();
            let mut managed = state.managed.lock().unwrap();
            for name in &boot {
                managed.insert(name.clone());
            }
        }
        for inst in read_instances() {
            if boot.contains(&inst.name) && !inst.running {
                if let Some(cfg) = inst.config_path.clone() {
                    let _ = run_cli(&app, &["--name", &inst.name, "--config", &cfg, "start"]).await;
                }
            }
        }
        // Per-instance consecutive-revive count. A connector that crash-loops
        // (e.g. its gateway is down) must not restart-and-notify every 30s: give
        // up after MAX_REVIVES with ONE "giving up" notice, and reset the count
        // once it's seen running again. A running instance resets to 0.
        const MAX_REVIVES: u32 = 3;
        let mut revive_counts: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let managed: Vec<String> = {
                let state = app.state::<SupervisorState>();
                let managed = state.managed.lock().unwrap();
                managed.iter().cloned().collect()
            };
            if managed.is_empty() {
                continue;
            }
            for inst in read_instances() {
                if !managed.contains(&inst.name) {
                    continue;
                }
                if inst.running {
                    revive_counts.remove(&inst.name); // healthy again → reset
                    continue;
                }
                let count = revive_counts.entry(inst.name.clone()).or_insert(0);
                if *count >= MAX_REVIVES {
                    continue; // gave up already; stay quiet until it runs again
                }
                // Re-check `managed` right before acting: the snapshot was taken
                // at the top of the loop, and a concurrent `connector_delete` may
                // have removed this instance since. Without this, a delete that
                // lands between the snapshot and the revive would resurrect the
                // just-deleted connector (stop it, then start_daemon rebuilds the
                // service dir + daemon.json). Belt-and-braces with removing the
                // name from managed first in connector_delete.
                let still_managed = {
                    let state = app.state::<SupervisorState>();
                    let managed = state.managed.lock().unwrap();
                    managed.contains(&inst.name)
                };
                if !still_managed {
                    revive_counts.remove(&inst.name);
                    continue;
                }
                *count += 1;
                let gave_up = *count >= MAX_REVIVES;
                // Revive with --config (+ ensure workspace dirs) so a daemon that
                // died before writing metadata can still come back.
                let cfg = inst.config_path.clone();
                if let Some(c) = &cfg {
                    ensure_workspace_dirs_at(Path::new(c));
                }
                let revived = match cfg.as_deref() {
                    Some(c) => {
                        run_cli(&app, &["--name", &inst.name, "--config", c, "restart"]).await
                    }
                    None => run_cli(&app, &["--name", &inst.name, "restart"]).await,
                };
                let body = match (&revived, gave_up) {
                    (Ok(_), false) => format!("Connector \"{}\" died and was restarted.", inst.name),
                    (Ok(_), true) => format!(
                        "Connector \"{}\" keeps dying — restarted a final time; won't retry again until it stays up.",
                        inst.name
                    ),
                    (Err(e), _) => format!(
                        "Connector \"{}\" died and could not be restarted: {e}",
                        inst.name
                    ),
                };
                let _ = app
                    .notification()
                    .builder()
                    .title("Cheers connector")
                    .body(body)
                    .show();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ps_group_sums_and_finds_leader() {
        // pid, rss(KiB), %cpu, stat — leader is pid 4242.
        let text = "4242 102400 12.5 S\n4300 204800 30.0 R\n";
        let (cpu, mem, count, leader) = parse_ps_group(text, 4242).unwrap();
        assert_eq!(count, 2);
        assert!((cpu - 42.5).abs() < 0.01);
        assert_eq!(mem, (102400 + 204800) * 1024);
        assert_eq!(leader.as_deref(), Some("S"));
    }

    #[test]
    fn parse_ps_group_empty_is_none() {
        assert!(parse_ps_group("", 1).is_none());
    }

    #[test]
    fn workspace_dirs_collected_and_home_scoped() {
        let home = Path::new("/home/u");
        let cfg = r#"
            [accounts.bot.policy.workspace]
            allowed_roots = ["/home/u/.cheers/workspace/bot", "/outside/data"]
            default_cwd = "/home/u/.cheers/workspace/bot/proj"
        "#;
        let dirs = workspace_dirs_in_config(cfg, home);
        // The two home-scoped paths are kept; the out-of-home root is dropped.
        assert!(dirs.contains(&PathBuf::from("/home/u/.cheers/workspace/bot")));
        assert!(dirs.contains(&PathBuf::from("/home/u/.cheers/workspace/bot/proj")));
        assert!(!dirs.iter().any(|p| p.starts_with("/outside")));
        assert_eq!(dirs.len(), 2);
    }

    #[test]
    fn workspace_dirs_malformed_or_empty_is_empty() {
        assert!(workspace_dirs_in_config("not = valid = toml", Path::new("/home/u")).is_empty());
        assert!(workspace_dirs_in_config("[unrelated]\nx = 1", Path::new("/home/u")).is_empty());
    }

    #[test]
    fn classify_health_thresholds() {
        assert_eq!(classify_health(10.0, 100, Some("S")), "healthy");
        assert_eq!(classify_health(200.0, 100, Some("R")), "high_cpu");
        assert_eq!(
            classify_health(10.0, 3 * 1024 * 1024 * 1024, Some("S")),
            "high_mem"
        );
        assert_eq!(classify_health(10.0, 100, Some("Z")), "stuck");
        assert_eq!(classify_health(999.0, 100, Some("T+")), "stuck"); // stopped wins over cpu
    }

    #[test]
    fn version_ordering() {
        assert!(version_is_newer("1.2.9", "1.2.10"));
        assert!(!version_is_newer("1.2.0", "1.2.0"));
        assert!(!version_is_newer("2.0.0", "1.9.9"));
        assert!(version_is_newer("0.1.0", "0.1.1"));
    }

    #[test]
    fn npm_package_extraction() {
        assert_eq!(
            npm_package_of("npm install -g opencode-ai"),
            Some("opencode-ai")
        );
        assert_eq!(
            npm_package_of("npm install -g @agentclientprotocol/claude-agent-acp"),
            Some("@agentclientprotocol/claude-agent-acp")
        );
        assert_eq!(npm_package_of(""), None);
    }

    // `workspace_cwd_allowed` is written pure (no direct I/O): `~` expansion and
    // canonicalize are both side-effect-free over these fixtures, so the
    // absolute-path cases are deterministic regardless of the test machine.
    #[test]
    fn workspace_cwd_allowed_absolute_paths() {
        // cwd directly under a root.
        assert!(workspace_cwd_allowed(
            "/Users/dev/Projects/Cheers",
            &["/Users/dev/Projects".to_string()]
        ));
        // cwd is exactly a root.
        assert!(workspace_cwd_allowed(
            "/Users/dev/Projects",
            &["/Users/dev/Projects".to_string()]
        ));
        // cwd is the sibling of a root — not under it.
        assert!(!workspace_cwd_allowed(
            "/Users/dev/Other",
            &["/Users/dev/Projects".to_string()]
        ));
        // Matches the second root out of several.
        assert!(workspace_cwd_allowed(
            "/Users/dev/Projects/Cheers",
            &["/var/empty".to_string(), "/Users/dev/Projects".to_string()]
        ));
        // Empty roots → unrestricted (mirrors the connector).
        assert!(workspace_cwd_allowed("/anywhere/else", &[]));
    }

    #[test]
    fn workspace_cwd_allowed_tilde_and_command_layer_none() {
        // Same `~/...` prefix on both sides compares equal as strings.
        assert!(workspace_cwd_allowed("~/Projects/Cheers", &["~/Projects".to_string()]));
        assert!(!workspace_cwd_allowed("~/Other", &["~/Projects".to_string()]));
        // The command layer trims + filters blank cwd → None → true; the helper
        // itself reports the literal fact that "" is under no root.
        assert!(super::connector_validate_workspace(None, vec!["/root".into()]));
        assert!(super::connector_validate_workspace(Some("".into()), vec!["/root".into()]));
        assert!(super::connector_validate_workspace(Some("   ".into()), vec!["/root".into()]));
    }
}
