//! Host-owned PTYs. No agent tool can reach this registry.
use cheers_bridge_protocol::RemoteExecutionRequest;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const OUTPUT_CAP: usize = 256 * 1024;
struct TerminalState {
    output: Vec<u8>,
    base: u64,
    status: &'static str,
    exit_code: Option<u32>,
}
struct Terminal {
    child_running: AtomicBool,
    user: String,
    command: Option<String>,
    cwd: String,
    created: Instant,
    state: Mutex<TerminalState>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}
impl Terminal {
    fn stop(&self) -> anyhow::Result<()> {
        let mut killer = self.killer.lock().unwrap();
        // A ChildKiller stores a PID; never signal it after wait() reaped the child.
        if !self.child_running.load(Ordering::Acquire) {
            return Ok(());
        }
        #[cfg(unix)]
        if let Some(group) = self.master.lock().unwrap().process_group_leader() {
            // The foreground process group belongs to this live PTY. Kill its children too.
            if group > 1 {
                unsafe {
                    libc::kill(-group, libc::SIGKILL);
                }
            }
        }
        killer.kill()?;
        Ok(())
    }
}
#[derive(Default)]
pub(super) struct RemoteRegistry {
    sessions: Mutex<HashMap<String, Arc<Terminal>>>,
}
impl Drop for RemoteRegistry {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.get_mut() {
            for session in sessions.values() {
                if session.state.lock().unwrap().status == "running" {
                    let _ = session.stop();
                }
            }
        }
    }
}
impl RemoteRegistry {
    pub(super) fn handle(
        &self,
        request: RemoteExecutionRequest,
        target: &Path,
        root: &Path,
        terminal_allowed: bool,
        open_allowed: bool,
        env: &BTreeMap<String, String>,
    ) -> anyhow::Result<Value> {
        if uuid::Uuid::parse_str(&request.execution_id).is_err()
            || uuid::Uuid::parse_str(&request.user_id).is_err()
        {
            anyhow::bail!("Invalid execution identity");
        }
        if request.action == "file.open" {
            if !open_allowed {
                anyhow::bail!("Remote file opening is disabled on this host");
            }
            let file = target.canonicalize()?;
            if !file.starts_with(root) || !file.is_file() {
                anyhow::bail!("File is outside the registered root or is not a file");
            }
            let opener = request.opener.as_deref().unwrap_or("finder");
            let mut command = if cfg!(target_os = "macos") {
                let app = match opener {
                    "finder" => "Finder",
                    "vscode" => "Visual Studio Code",
                    "zed" => "Zed",
                    _ => anyhow::bail!("Unsupported opener"),
                };
                let mut command = std::process::Command::new("/usr/bin/open");
                command.args(["-a", app, "--"]);
                command
            } else {
                let program = match opener {
                    "finder" => "xdg-open",
                    "vscode" => "code",
                    "zed" => "zed",
                    _ => anyhow::bail!("Unsupported opener"),
                };
                std::process::Command::new(program)
            };
            command
                .arg(file)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            let mut child = command.spawn()?;
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(status) = child.try_wait()? {
                    if !status.success() {
                        anyhow::bail!("The registered application could not open this file");
                    }
                    return Ok(json!({"status":"succeeded","disposition":"remote-original"}));
                }
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    anyhow::bail!("File opening timed out");
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
        if !terminal_allowed {
            anyhow::bail!("Remote terminal is disabled on this host");
        }
        if request
            .command
            .as_ref()
            .is_some_and(|c| c.len() > 16_000 || c.contains('\0'))
        {
            anyhow::bail!("Invalid command");
        }
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, s| {
            s.state.lock().unwrap().status == "running"
                || s.created.elapsed() < Duration::from_secs(600)
        });
        if request.action == "terminal.start" && !sessions.contains_key(&request.execution_id) {
            if sessions.len() >= 32
                || sessions
                    .values()
                    .filter(|s| s.state.lock().unwrap().status == "running")
                    .count()
                    >= 8
            {
                anyhow::bail!("Too many remote terminals");
            }
            let cwd = target.canonicalize()?;
            if !cwd.starts_with(root) || !cwd.is_dir() {
                anyhow::bail!("Terminal directory is outside the registered root");
            }
            let pair = native_pty_system().openpty(PtySize {
                rows: request.rows.unwrap_or(24).clamp(2, 200),
                cols: request.cols.unwrap_or(80).clamp(10, 400),
                pixel_width: 0,
                pixel_height: 0,
            })?;
            let mut command = CommandBuilder::new("/bin/sh");
            command.env_clear();
            for (key, value) in env {
                command.env(key, value);
            }
            command.env("TERM", "xterm-256color");
            command.cwd(&cwd);
            if let Some(code) = &request.command {
                command.args(["-lc", code.as_str()]);
            } else {
                command.arg("-i");
            }
            let mut child = pair.slave.spawn_command(command)?;
            let killer = child.clone_killer();
            let mut reader = pair.master.try_clone_reader()?;
            let writer = pair.master.take_writer()?;
            drop(pair.slave);
            let terminal = Arc::new(Terminal {
                child_running: AtomicBool::new(true),
                user: request.user_id.clone(),
                command: request.command.clone(),
                cwd: cwd.to_string_lossy().into_owned(),
                created: Instant::now(),
                state: Mutex::new(TerminalState {
                    output: Vec::new(),
                    base: 0,
                    status: "running",
                    exit_code: None,
                }),
                writer: Mutex::new(writer),
                master: Mutex::new(pair.master),
                killer: Mutex::new(killer),
            });
            let output = Arc::downgrade(&terminal);
            let (drained_tx, drained_rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut buffer = [0u8; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let Some(output) = output.upgrade() else {
                                break;
                            };
                            let mut state = output.state.lock().unwrap();
                            state.output.extend_from_slice(&buffer[..n]);
                            if state.output.len() > OUTPUT_CAP {
                                let remove = state.output.len() - OUTPUT_CAP;
                                state.output.drain(..remove);
                                state.base += remove as u64;
                            }
                        }
                    }
                }
                let _ = drained_tx.send(());
            });
            let finished = terminal.clone();
            std::thread::spawn(move || {
                let result = loop {
                    // Reaping and cancellation share a lock: an exited child's PID
                    // remains reserved until we mark it unavailable for signalling.
                    let guard = finished.killer.lock().unwrap();
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            finished.child_running.store(false, Ordering::Release);
                            break Ok(status);
                        }
                        Err(error) => {
                            finished.child_running.store(false, Ordering::Release);
                            break Err(error);
                        }
                        Ok(None) => {
                            drop(guard);
                            std::thread::sleep(Duration::from_millis(20));
                        }
                    }
                };
                // Background children must not keep a completed shell receipt running forever.
                let _ = drained_rx.recv_timeout(Duration::from_millis(250));
                let mut state = finished.state.lock().unwrap();
                if state.status == "running" {
                    state.status = if result.as_ref().is_ok_and(|s| s.success()) {
                        "succeeded"
                    } else {
                        "failed"
                    };
                }
                state.exit_code = result.ok().map(|s| s.exit_code());
            });
            let expires = Arc::downgrade(&terminal);
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(1));
                let Some(terminal) = expires.upgrade() else {
                    break;
                };
                let mut state = terminal.state.lock().unwrap();
                if state.status != "running" {
                    break;
                }
                if terminal.created.elapsed() > Duration::from_secs(900) {
                    state.status = "cancelled";
                    drop(state);
                    let _ = terminal.stop();
                    break;
                }
            });
            sessions.insert(request.execution_id.clone(), terminal);
        }
        let terminal = sessions
            .get(&request.execution_id)
            .cloned()
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Terminal receipt is no longer on this host; the connector may have restarted"
                )
            })?;
        drop(sessions);
        if terminal.user != request.user_id {
            anyhow::bail!("Terminal belongs to another user");
        }
        match request.action.as_str() {
            "terminal.start" => {
                if terminal.command != request.command
                    || terminal.cwd != target.canonicalize()?.to_string_lossy()
                {
                    anyhow::bail!("Execution id was reused with different input");
                }
            }
            "terminal.input" => {
                let input = request.input.as_deref().unwrap_or("");
                if input.len() > 8192 {
                    anyhow::bail!("Input is too large");
                }
                if terminal.state.lock().unwrap().status != "running" {
                    anyhow::bail!("Terminal has finished");
                }
                let mut writer = terminal.writer.lock().unwrap();
                writer.write_all(input.as_bytes())?;
                writer.flush()?;
            }
            "terminal.resize" => terminal.master.lock().unwrap().resize(PtySize {
                rows: request.rows.unwrap_or(24).clamp(2, 200),
                cols: request.cols.unwrap_or(80).clamp(10, 400),
                pixel_width: 0,
                pixel_height: 0,
            })?,
            "terminal.cancel" => {
                let mut state = terminal.state.lock().unwrap();
                if state.status == "running" {
                    state.status = "cancelled";
                    drop(state);
                    terminal.stop()?;
                }
            }
            "terminal.status" => {}
            _ => anyhow::bail!("Unsupported remote operation"),
        }
        let state = terminal.state.lock().unwrap();
        let offset = request
            .offset
            .max(state.base)
            .min(state.base + state.output.len() as u64);
        use base64::Engine;
        Ok(
            json!({"status":state.status,"exit_code":state.exit_code,"offset":offset,
            "next_offset":state.base+state.output.len() as u64,"truncated":request.offset<state.base,
            "output_b64":base64::engine::general_purpose::STANDARD.encode(&state.output[(offset-state.base) as usize..])}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interactive_input_resize_owner_and_cancel() {
        let registry = RemoteRegistry::default();
        let root = std::env::temp_dir().canonicalize().unwrap();
        let mut request = RemoteExecutionRequest {
            execution_id: uuid::Uuid::new_v4().to_string(),
            host_id: uuid::Uuid::new_v4().to_string(),
            user_id: uuid::Uuid::new_v4().to_string(),
            action: "terminal.start".into(),
            command: None,
            opener: None,
            input: None,
            offset: 0,
            cols: Some(90),
            rows: Some(30),
        };
        registry
            .handle(request.clone(), &root, &root, true, false, &BTreeMap::new())
            .unwrap();
        let mut intruder = request.clone();
        intruder.user_id = uuid::Uuid::new_v4().to_string();
        intruder.action = "terminal.input".into();
        intruder.input = Some("echo forbidden\n".into());
        assert!(registry
            .handle(intruder, &root, &root, true, false, &BTreeMap::new())
            .is_err());
        request.action = "terminal.resize".into();
        request.cols = Some(120);
        registry
            .handle(request.clone(), &root, &root, true, false, &BTreeMap::new())
            .unwrap();
        request.action = "terminal.input".into();
        request.input = Some("printf 'cheers-input-ok\\n'\n".into());
        registry
            .handle(request.clone(), &root, &root, true, false, &BTreeMap::new())
            .unwrap();
        request.action = "terminal.status".into();
        let mut observed = false;
        for _ in 0..100 {
            let v = registry
                .handle(request.clone(), &root, &root, true, false, &BTreeMap::new())
                .unwrap();
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(v["output_b64"].as_str().unwrap())
                .unwrap();
            if String::from_utf8_lossy(&bytes).contains("cheers-input-ok") {
                observed = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(observed, "Interactive shell did not receive input");
        request.action = "terminal.cancel".into();
        assert_eq!(
            registry
                .handle(request, &root, &root, true, false, &BTreeMap::new())
                .unwrap()["status"],
            "cancelled"
        );
    }
    #[test]
    fn real_pty_execution_and_replay() {
        let registry = RemoteRegistry::default();
        let root = std::env::temp_dir().canonicalize().unwrap();
        let mut request = RemoteExecutionRequest {
            execution_id: uuid::Uuid::new_v4().to_string(),
            host_id: uuid::Uuid::new_v4().to_string(),
            user_id: uuid::Uuid::new_v4().to_string(),
            action: "terminal.start".into(),
            command: Some("printf cheers-pty".into()),
            opener: None,
            input: None,
            offset: 0,
            cols: None,
            rows: None,
        };
        assert!(registry
            .handle(
                request.clone(),
                &root,
                &root,
                false,
                false,
                &BTreeMap::new()
            )
            .is_err());
        registry
            .handle(request.clone(), &root, &root, true, false, &BTreeMap::new())
            .unwrap();
        request.action = "terminal.status".into();
        for _ in 0..100 {
            let result = registry
                .handle(request.clone(), &root, &root, true, false, &BTreeMap::new())
                .unwrap();
            if result["status"] != "running" {
                assert_eq!(result["status"], "succeeded");
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(result["output_b64"].as_str().unwrap())
                    .unwrap();
                assert!(String::from_utf8_lossy(&bytes).contains("cheers-pty"));
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("PTY did not complete");
    }
}
