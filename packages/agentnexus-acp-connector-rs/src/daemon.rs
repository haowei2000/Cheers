use std::env;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::time::sleep;

use crate::config::load_daemon_file_config;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

const DAEMON_METADATA_VERSION: u32 = 1;
const DAEMON_RUNTIME_KIND: &str = "rust-supervisor";

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct DaemonPaths {
    pub home_dir: PathBuf,
    pub service_dir: PathBuf,
    pub metadata_path: PathBuf,
    pub stdout_log_path: PathBuf,
    pub stderr_log_path: PathBuf,
}

impl DaemonPaths {
    fn with_log_dir(mut self, name: &str, log_dir: PathBuf) -> Self {
        self.stdout_log_path = log_dir.join(format!("{name}.stdout.log"));
        self.stderr_log_path = log_dir.join(format!("{name}.stderr.log"));
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonMetadata {
    #[serde(default = "default_daemon_metadata_version")]
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_kind: Option<String>,
    pub name: String,
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_group_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<PathBuf>,
    pub config_path: PathBuf,
    pub started_at: String,
    pub cwd: PathBuf,
    pub argv: Vec<String>,
    pub stdout_log_path: PathBuf,
    pub stderr_log_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct DaemonStatus {
    pub name: String,
    pub running: bool,
    pub metadata: Option<DaemonMetadata>,
    pub paths: DaemonPaths,
}

#[derive(Debug, Clone)]
pub struct StartDaemonOptions {
    pub name: String,
    pub config_path: PathBuf,
    pub home_dir: Option<PathBuf>,
}

pub fn resolve_daemon_paths(name: &str, home_dir: Option<&Path>) -> anyhow::Result<DaemonPaths> {
    let root = match home_dir {
        Some(path) => path.to_path_buf(),
        None => default_home_dir()?,
    };
    let home_dir = root.canonicalize().unwrap_or(root);
    let service_dir = home_dir.join(safe_name(name));
    Ok(DaemonPaths {
        home_dir,
        metadata_path: service_dir.join("daemon.json"),
        stdout_log_path: service_dir.join("stdout.log"),
        stderr_log_path: service_dir.join("stderr.log"),
        service_dir,
    })
}

pub async fn daemon_status(name: &str, home_dir: Option<&Path>) -> anyhow::Result<DaemonStatus> {
    let name = safe_name(name);
    let paths = resolve_daemon_paths(&name, home_dir)?;
    let metadata = read_metadata(&paths).await?;
    let running = metadata
        .as_ref()
        .map(daemon_process_is_running)
        .unwrap_or(false);
    Ok(DaemonStatus {
        name,
        running,
        metadata,
        paths,
    })
}

pub async fn start_daemon(options: StartDaemonOptions) -> anyhow::Result<DaemonMetadata> {
    let name = safe_name(&options.name);
    let mut paths = resolve_daemon_paths(&name, options.home_dir.as_deref())?;
    let existing = daemon_status(&name, options.home_dir.as_deref()).await?;
    if existing.running {
        if let Some(metadata) = existing.metadata {
            return Ok(metadata);
        }
    }
    if existing.metadata.is_some() {
        remove_metadata(&paths).await?;
    }

    let config_path = fs::canonicalize(&options.config_path).with_context(|| {
        format!(
            "config file does not exist: {}",
            options.config_path.display()
        )
    })?;
    let daemon_config = load_daemon_file_config(&config_path).await?;
    if let Some(log_dir) = daemon_config.log_dir {
        paths = paths.with_log_dir(&name, log_dir);
    }
    fs::create_dir_all(&paths.service_dir)
        .with_context(|| format!("failed to create {}", paths.service_dir.display()))?;
    if let Some(parent) = paths.stdout_log_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }

    let stdout = append_log(&paths.stdout_log_path)?;
    let stderr = append_log(&paths.stderr_log_path)?;
    let executable = env::current_exe().context("failed to resolve current executable")?;
    let cwd = env::current_dir().context("failed to resolve current directory")?;
    let argv = build_supervisor_argv(&executable, &config_path, &name);

    let mut command = Command::new(&executable);
    command
        .args(argv.iter().skip(1))
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .env("AGENTNEXUS_ACP_DAEMON", "1")
        .env("AGENTNEXUS_ACP_DAEMON_NAME", &name);
    set_process_group(&mut command);
    let child = command.spawn().context("failed to start daemon process")?;
    let pid = child.id();
    drop(child);

    let metadata = DaemonMetadata {
        schema_version: DAEMON_METADATA_VERSION,
        runtime_kind: Some(DAEMON_RUNTIME_KIND.to_string()),
        name,
        pid,
        process_group_id: Some(pid),
        executable_path: Some(executable),
        config_path,
        started_at: Utc::now().to_rfc3339(),
        cwd,
        argv,
        stdout_log_path: paths.stdout_log_path.clone(),
        stderr_log_path: paths.stderr_log_path.clone(),
    };
    write_metadata(&paths, &metadata).await?;

    sleep(Duration::from_millis(1200)).await;
    if !daemon_process_is_running(&metadata) {
        let err_tail = tail_file(&paths.stderr_log_path, 80)
            .await
            .unwrap_or_default();
        remove_metadata(&paths).await?;
        return Err(anyhow!(
            "daemon exited during startup{}",
            if err_tail.is_empty() {
                String::new()
            } else {
                format!(":\n{err_tail}")
            }
        ));
    }
    Ok(metadata)
}

pub async fn stop_daemon(
    name: &str,
    home_dir: Option<&Path>,
    timeout: Option<Duration>,
) -> anyhow::Result<DaemonStatus> {
    let name = safe_name(name);
    let paths = resolve_daemon_paths(&name, home_dir)?;
    let before = daemon_status(&name, home_dir).await?;
    let Some(metadata) = before.metadata else {
        return Ok(before);
    };
    if !before.running {
        remove_metadata(&paths).await?;
        return daemon_status(&name, home_dir).await;
    }

    signal_daemon_process(&metadata, libc::SIGTERM);
    let deadline = Instant::now() + timeout.unwrap_or_else(|| Duration::from_secs(10));
    while Instant::now() < deadline {
        if !daemon_process_is_running(&metadata) {
            remove_metadata(&paths).await?;
            return daemon_status(&name, home_dir).await;
        }
        sleep(Duration::from_millis(250)).await;
    }

    signal_daemon_process(&metadata, libc::SIGKILL);
    sleep(Duration::from_millis(500)).await;
    remove_metadata(&paths).await?;
    daemon_status(&name, home_dir).await
}

pub async fn restart_daemon(options: StartDaemonOptions) -> anyhow::Result<DaemonMetadata> {
    stop_daemon(&options.name, options.home_dir.as_deref(), None).await?;
    start_daemon(options).await
}

pub async fn daemon_logs(
    name: &str,
    home_dir: Option<&Path>,
    lines: usize,
) -> anyhow::Result<String> {
    let status = daemon_status(name, home_dir).await?;
    let paths = status.paths;
    let (stdout_log_path, stderr_log_path) = status
        .metadata
        .map(|metadata| (metadata.stdout_log_path, metadata.stderr_log_path))
        .unwrap_or_else(|| (paths.stdout_log_path.clone(), paths.stderr_log_path.clone()));
    let lines = lines.max(1);
    let stdout = tail_file(&stdout_log_path, lines).await.unwrap_or_default();
    let stderr = tail_file(&stderr_log_path, lines).await.unwrap_or_default();
    Ok(format!(
        "==> {} <==\n{}\n\n==> {} <==\n{}",
        stdout_log_path.display(),
        if stdout.is_empty() {
            "(empty)"
        } else {
            stdout.trim_end()
        },
        stderr_log_path.display(),
        if stderr.is_empty() {
            "(empty)"
        } else {
            stderr.trim_end()
        },
    ))
}

fn append_log(path: &Path) -> anyhow::Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("failed to open log {}", path.display()))
}

async fn read_metadata(paths: &DaemonPaths) -> anyhow::Result<Option<DaemonMetadata>> {
    let text = match tokio::fs::read_to_string(&paths.metadata_path).await {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(err)
                .with_context(|| format!("failed to read {}", paths.metadata_path.display()))
        }
    };
    let metadata: DaemonMetadata = serde_json::from_str(&text)
        .with_context(|| format!("failed to parse {}", paths.metadata_path.display()))?;
    if metadata.name.trim().is_empty() || metadata.pid == 0 {
        return Ok(None);
    }
    Ok(Some(metadata))
}

async fn write_metadata(paths: &DaemonPaths, metadata: &DaemonMetadata) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(&paths.service_dir).await?;
    let text = serde_json::to_string_pretty(metadata)?;
    tokio::fs::write(&paths.metadata_path, format!("{text}\n"))
        .await
        .with_context(|| format!("failed to write {}", paths.metadata_path.display()))
}

async fn remove_metadata(paths: &DaemonPaths) -> anyhow::Result<()> {
    match tokio::fs::remove_file(&paths.metadata_path).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => {
            Err(err).with_context(|| format!("failed to remove {}", paths.metadata_path.display()))
        }
    }
}

async fn tail_file(path: &Path, lines: usize) -> anyhow::Result<String> {
    let text = match tokio::fs::read_to_string(path).await {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(err) => return Err(err).with_context(|| format!("failed to read {}", path.display())),
    };
    let split: Vec<&str> = text.lines().collect();
    let start = split.len().saturating_sub(lines.max(1));
    Ok(split[start..].join("\n"))
}

fn default_home_dir() -> anyhow::Result<PathBuf> {
    if let Ok(home) = env::var("AGENTNEXUS_ACP_HOME") {
        return Ok(PathBuf::from(home));
    }
    let home = env::var("HOME").map_err(|_| anyhow!("HOME is not set"))?;
    Ok(PathBuf::from(home).join(".agentnexus/acp-connector"))
}

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

fn pid_is_running(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }

    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as i32, 0) };
        if result == 0 {
            return true;
        }
        let err = std::io::Error::last_os_error();
        return err.raw_os_error() == Some(libc::EPERM);
    }

    #[cfg(not(unix))]
    {
        false
    }
}

fn signal_process(pid: u32, signal: i32) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, signal);
    }
    #[cfg(not(unix))]
    let _ = (pid, signal);
}

fn signal_process_group(pid: u32, signal: i32) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
    #[cfg(not(unix))]
    let _ = (pid, signal);
}

fn set_process_group(command: &mut Command) {
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = command;
}

fn default_daemon_metadata_version() -> u32 {
    DAEMON_METADATA_VERSION
}

fn build_supervisor_argv(executable: &Path, config_path: &Path, name: &str) -> Vec<String> {
    vec![
        executable.display().to_string(),
        "run".to_string(),
        "--config".to_string(),
        config_path.display().to_string(),
        "--name".to_string(),
        name.to_string(),
    ]
}

fn daemon_process_is_running(metadata: &DaemonMetadata) -> bool {
    if !pid_is_running(metadata.pid) {
        return false;
    }
    if matches!(
        metadata.runtime_kind.as_deref(),
        Some(kind) if kind != DAEMON_RUNTIME_KIND
    ) {
        return false;
    }
    process_command_matches_metadata(metadata)
}

fn process_command_matches_metadata(metadata: &DaemonMetadata) -> bool {
    let expected = expected_daemon_argv(metadata);
    if expected.len() < 6 {
        return false;
    }

    match read_process_command(metadata.pid) {
        Some(ProcessCommandLine::Args(actual)) => argv_matches_expected(&actual, &expected),
        Some(ProcessCommandLine::Text(text)) => command_text_matches_expected(&text, &expected),
        None => false,
    }
}

fn expected_daemon_argv(metadata: &DaemonMetadata) -> Vec<String> {
    if !metadata.argv.is_empty() {
        return metadata.argv.clone();
    }
    match metadata.executable_path.as_deref() {
        Some(executable_path) => {
            build_supervisor_argv(executable_path, &metadata.config_path, &metadata.name)
        }
        None => Vec::new(),
    }
}

fn argv_matches_expected(actual: &[String], expected: &[String]) -> bool {
    if actual.len() >= expected.len()
        && actual
            .iter()
            .zip(expected.iter())
            .all(|(actual, expected)| actual == expected)
    {
        return true;
    }
    command_text_matches_expected(&actual.join(" "), expected)
}

fn command_text_matches_expected(command: &str, expected: &[String]) -> bool {
    let Some(executable) = expected.first() else {
        return false;
    };
    let executable_name = Path::new(executable)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(executable);
    let executable_matches = command.contains(executable) || command.contains(executable_name);
    executable_matches && expected.iter().skip(1).all(|arg| command.contains(arg))
}

#[allow(dead_code)]
enum ProcessCommandLine {
    Args(Vec<String>),
    Text(String),
}

#[cfg(target_os = "linux")]
fn read_process_command(pid: u32) -> Option<ProcessCommandLine> {
    let bytes = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let args: Vec<String> = bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).to_string())
        .collect();
    if args.is_empty() {
        None
    } else {
        Some(ProcessCommandLine::Args(args))
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
fn read_process_command(pid: u32) -> Option<ProcessCommandLine> {
    let output = Command::new("ps")
        .arg("-ww")
        .arg("-p")
        .arg(pid.to_string())
        .arg("-o")
        .arg("command=")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(ProcessCommandLine::Text(text))
    }
}

#[cfg(not(unix))]
fn read_process_command(_pid: u32) -> Option<ProcessCommandLine> {
    None
}

fn signal_daemon_process(metadata: &DaemonMetadata, signal: i32) {
    signal_process(metadata.pid, signal);
    signal_process_group(metadata.process_group_id.unwrap_or(metadata.pid), signal);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn safe_name_removes_unsafe_segments() {
        assert_eq!(safe_name(" opencode/main "), "opencode-main");
        assert_eq!(safe_name("///"), "default");
        assert_eq!(safe_name("alpha_beta.1"), "alpha_beta.1");
    }

    #[test]
    fn old_metadata_json_still_loads() {
        let metadata: DaemonMetadata = serde_json::from_value(json!({
            "name": "opencode-main",
            "pid": 1234,
            "config_path": "/tmp/agentnexus-acp.json",
            "started_at": "2026-06-02T00:00:00Z",
            "cwd": "/tmp",
            "argv": [
                "/usr/local/bin/agentnexus-acp-connector",
                "run",
                "--config",
                "/tmp/agentnexus-acp.json",
                "--name",
                "opencode-main"
            ],
            "stdout_log_path": "/tmp/stdout.log",
            "stderr_log_path": "/tmp/stderr.log"
        }))
        .expect("old metadata should deserialize");

        assert_eq!(metadata.schema_version, DAEMON_METADATA_VERSION);
        assert!(metadata.runtime_kind.is_none());
        assert!(metadata.process_group_id.is_none());
    }

    #[test]
    fn argv_match_requires_the_supervisor_invocation() {
        let expected = vec![
            "/usr/local/bin/agentnexus-acp-connector".to_string(),
            "run".to_string(),
            "--config".to_string(),
            "/tmp/agentnexus-acp.json".to_string(),
            "--name".to_string(),
            "opencode-main".to_string(),
        ];
        assert!(argv_matches_expected(&expected, &expected));

        let wrong_config = vec![
            "/usr/local/bin/agentnexus-acp-connector".to_string(),
            "run".to_string(),
            "--config".to_string(),
            "/tmp/other.json".to_string(),
            "--name".to_string(),
            "opencode-main".to_string(),
        ];
        assert!(!argv_matches_expected(&wrong_config, &expected));
    }

    #[test]
    fn command_text_match_accepts_ps_style_output() {
        let expected = vec![
            "/Users/me/bin/agentnexus-acp-connector".to_string(),
            "run".to_string(),
            "--config".to_string(),
            "/tmp/agentnexus-acp.json".to_string(),
            "--name".to_string(),
            "opencode-main".to_string(),
        ];
        assert!(command_text_matches_expected(
            "/Users/me/bin/agentnexus-acp-connector run --config /tmp/agentnexus-acp.json --name opencode-main",
            &expected,
        ));
        assert!(!command_text_matches_expected(
            "/Users/me/bin/agentnexus-acp-connector run --config /tmp/agentnexus-acp.json --name other",
            &expected,
        ));
    }
}
