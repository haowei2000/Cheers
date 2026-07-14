//! Opt-in connector self-update.
//!
//! Trigger: the gateway hello advertises `server_capabilities.latest_connector_version`
//! (the release its download proxy serves). When `[update] auto = true` and that
//! version is newer than `CARGO_PKG_VERSION`, a background task downloads the
//! release's signed manifest through the gateway proxy, verifies the manifest's
//! ed25519 signature against the release key pinned in this binary (or the
//! `[update] public_key_file` override for forks), verifies each binary's sha256
//! against the manifest, swaps the executables in place, and re-execs.
//!
//! Trust model: the gateway is only a transport. A connector never runs a byte
//! that isn't hash-listed in a manifest signed by the release key, so neither a
//! compromised gateway nor a tampering proxy can push code — they can at worst
//! withhold updates.
//!
//! Safety rails:
//! - Draining: the swap waits until no prompt turn is in flight (`BusyGuard`).
//! - Rollback: the previous binary is kept as `<exe>.old` and a marker file
//!   tracks boot attempts of the new one; if it fails to reach a healthy bridge
//!   connection `MAX_BOOT_ATTEMPTS` times, startup restores `<exe>.old` and
//!   blocks that version from being retried.
//! - Containers never self-update (image rebuilds own that path), and
//!   `CHEERS_ACP_NO_SELF_UPDATE=1` force-disables regardless of config.
//!
//! When self-update is OFF (or unavailable) the connector still tells the owner:
//! a newer advertised version is persisted to `self-update/available.json`, a
//! manual-update warning is logged both when the hello arrives and on every
//! subsequent startup, and `cce-acp-connector status` surfaces it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use ed25519_dalek::pkcs8::DecodePublicKey;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::UpdateSettings;

/// Release-signing public key baked into every build. The matching private key
/// lives only in CI (`CONNECTOR_SIGNING_KEY` secret) — see release-connector.yml.
const EMBEDDED_RELEASE_PUBKEY: &str = include_str!("../release-signing-pubkey.pem");

/// Boot attempts a freshly-swapped binary gets to reach a healthy bridge
/// connection before startup rolls back to `<exe>.old`.
const MAX_BOOT_ATTEMPTS: u32 = 3;

const DRAIN_POLL: Duration = Duration::from_secs(5);

/// Prompt turns currently in flight, process-wide. The updater refuses to swap
/// binaries while this is non-zero so an exec never cuts off a streaming reply.
static ACTIVE_PROMPTS: AtomicUsize = AtomicUsize::new(0);

/// RAII busy marker held for the duration of one `run_task` (queued turns count
/// too — a swap mid-queue would drop them just as hard as a swap mid-stream).
pub struct BusyGuard;

impl BusyGuard {
    pub fn new() -> Self {
        ACTIVE_PROMPTS.fetch_add(1, Ordering::SeqCst);
        BusyGuard
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        ACTIVE_PROMPTS.fetch_sub(1, Ordering::SeqCst);
    }
}

fn active_prompts() -> usize {
    ACTIVE_PROMPTS.load(Ordering::SeqCst)
}

// ── manifest ──────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct Manifest {
    version: String,
    assets: std::collections::BTreeMap<String, ManifestAsset>,
}

#[derive(Debug, Deserialize)]
struct ManifestAsset {
    sha256: String,
}

/// Verify `sig_b64` (base64 ed25519 signature over the exact manifest bytes)
/// against `pubkey_pem`, then parse. Everything the updater trusts flows
/// through here — no manifest field is used before this returns Ok.
fn verify_and_parse_manifest(
    manifest_bytes: &[u8],
    sig_b64: &str,
    pubkey_pem: &str,
) -> anyhow::Result<Manifest> {
    let key = VerifyingKey::from_public_key_pem(pubkey_pem)
        .map_err(|e| anyhow!("invalid release-signing public key: {e}"))?;
    let sig_bytes = BASE64
        .decode(sig_b64.trim())
        .context("manifest signature is not valid base64")?;
    let sig = Signature::from_slice(&sig_bytes)
        .map_err(|e| anyhow!("manifest signature has wrong length: {e}"))?;
    key.verify_strict(manifest_bytes, &sig)
        .map_err(|e| anyhow!("manifest signature verification FAILED: {e}"))?;
    serde_json::from_slice(manifest_bytes).context("signed manifest is not valid JSON")
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// ── version / platform / url helpers ─────────────────────────────────────────

pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Strict numeric semver-triple compare; anything unparsable is "not newer".
fn version_is_newer(candidate: &str, current: &str) -> bool {
    fn triple(s: &str) -> Option<(u64, u64, u64)> {
        let mut it = s.trim().trim_start_matches('v').splitn(3, '.');
        Some((
            it.next()?.parse().ok()?,
            it.next()?.parse().ok()?,
            it.next()?.parse().ok()?,
        ))
    }
    match (triple(candidate), triple(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// Release-asset suffix for this build, matching the release-connector.yml
/// matrix. None on platforms the release doesn't ship (no self-update there).
fn platform_asset_suffix() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "x86_64") => Some("darwin-amd64"),
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("linux", "x86_64") => Some("linux-amd64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        _ => None,
    }
}

/// Derive the gateway's download-proxy base from the control WS URL: the API
/// and the bridge share one origin and path prefix, so
/// `wss://host[/prefix]/ws/agent-bridge/control` → `https://host[/prefix]/api/v1/connector/download`.
fn download_base_from_control_url(control_url: &str) -> Option<String> {
    let (scheme, rest) = if let Some(rest) = control_url.strip_prefix("wss://") {
        ("https://", rest)
    } else if let Some(rest) = control_url.strip_prefix("ws://") {
        ("http://", rest)
    } else {
        return None;
    };
    let path_start = rest.find('/')?;
    let (host, path) = rest.split_at(path_start);
    let prefix = path.strip_suffix("/ws/agent-bridge/control")?;
    Some(format!("{scheme}{host}{prefix}/api/v1/connector/download"))
}

// ── rollback marker ───────────────────────────────────────────────────────────

/// Persisted next to the session state, one generation of update history:
/// which version was just applied, where the previous binary went, and how many
/// times the new binary has booted without reaching a healthy connection.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Marker {
    version: String,
    previous_exe: Option<PathBuf>,
    attempts: u32,
    confirmed: bool,
    /// Versions that were rolled back — never auto-retried, so a bad release
    /// can't put the connector into a swap/rollback loop.
    #[serde(default)]
    blocked_versions: Vec<String>,
}

fn marker_path(state_dir: &Path) -> PathBuf {
    state_dir.join("self-update").join("marker.json")
}

// ── "update available" notice ─────────────────────────────────────────────────

/// Persisted whenever a gateway advertises a release newer than this binary, so
/// the reminder survives to the next startup (before any gateway is reachable)
/// and `cce-acp-connector status` can show it without a config or a connection.
#[derive(Debug, Serialize, Deserialize)]
pub struct AvailableUpdate {
    pub latest: String,
    pub download_base: Option<String>,
}

impl AvailableUpdate {
    /// Direct download URL for this platform's connector binary, when both the
    /// gateway base and a prebuilt asset exist.
    pub fn download_url(&self) -> Option<String> {
        let base = self.download_base.as_deref()?;
        let suffix = platform_asset_suffix()?;
        Some(format!("{base}/cce-acp-connector-{suffix}"))
    }

    fn manual_hint(&self, reason: &str) -> String {
        let how = if reason.contains("container") {
            "rebuild/pull the bot image built from the new release".to_string()
        } else {
            let get = match self.download_url() {
                Some(url) => {
                    format!("download {url} (and the matching cheers-mcp-server)")
                }
                None => "install the new release binaries".to_string(),
            };
            format!(
                "{get}, replace the installed binaries, then run `cce-acp-connector restart`; \
                 or set `[update] auto = true` in the connector config to update automatically"
            )
        };
        format!(
            "connector {} is available (running {}; self-update off: {reason}). \
             To update: {how}.",
            self.latest,
            current_version()
        )
    }
}

fn available_path(state_dir: &Path) -> PathBuf {
    state_dir.join("self-update").join("available.json")
}

/// Read the persisted notice, dropping it once it's stale (the binary caught
/// up, e.g. via a manual update) so old reminders can't outlive their truth.
pub fn available_update(state_dir: &Path) -> Option<AvailableUpdate> {
    let bytes = std::fs::read(available_path(state_dir)).ok()?;
    let notice: AvailableUpdate = serde_json::from_slice(&bytes).ok()?;
    if version_is_newer(&notice.latest, current_version()) {
        Some(notice)
    } else {
        let _ = std::fs::remove_file(available_path(state_dir));
        None
    }
}

fn write_available(state_dir: &Path, notice: &AvailableUpdate) -> anyhow::Result<()> {
    let path = available_path(state_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(notice)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn read_marker(state_dir: &Path) -> Option<Marker> {
    let bytes = std::fs::read(marker_path(state_dir)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_marker(state_dir: &Path, marker: &Marker) -> anyhow::Result<()> {
    let path = marker_path(state_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(marker)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

// ── updater ───────────────────────────────────────────────────────────────────

pub struct SelfUpdater {
    settings: UpdateSettings,
    state_dir: PathBuf,
    started: AtomicBool,
    confirmed: AtomicBool,
    /// Last version a manual-update warning was emitted for — one warning per
    /// version per process, not one per reconnect/hello.
    noticed: std::sync::Mutex<Option<String>>,
}

impl SelfUpdater {
    pub fn new(settings: UpdateSettings, state_path: &Path) -> Arc<Self> {
        let state_dir = state_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        Arc::new(Self {
            settings,
            state_dir,
            started: AtomicBool::new(false),
            confirmed: AtomicBool::new(false),
            noticed: std::sync::Mutex::new(None),
        })
    }

    fn pubkey_pem(&self) -> &str {
        self.settings
            .public_key_pem
            .as_deref()
            .unwrap_or(EMBEDDED_RELEASE_PUBKEY)
    }

    fn disabled_reason(&self) -> Option<&'static str> {
        if !self.settings.auto {
            return Some("[update] auto is not enabled");
        }
        if std::env::var_os("CHEERS_ACP_NO_SELF_UPDATE").is_some() {
            return Some("CHEERS_ACP_NO_SELF_UPDATE is set");
        }
        // Containers get updates by image rebuild; an in-place swap would be
        // lost on the next container restart and fights the image digest.
        if Path::new("/.dockerenv").exists()
            || std::env::var_os("KUBERNETES_SERVICE_HOST").is_some()
        {
            return Some("running in a container (update the image instead)");
        }
        if platform_asset_suffix().is_none() {
            return Some("no prebuilt release asset for this platform");
        }
        None
    }

    /// Startup half of the rollback rail. Called before connecting: counts this
    /// boot against the pending marker and, once the new binary has burned
    /// `MAX_BOOT_ATTEMPTS` boots without ever confirming, puts `<exe>.old` back
    /// and execs it. Returns normally in every other case.
    pub fn startup_gate(&self) -> anyhow::Result<()> {
        let Some(mut marker) = read_marker(&self.state_dir) else {
            return Ok(());
        };
        if marker.confirmed {
            return Ok(());
        }
        marker.attempts += 1;
        if marker.attempts <= MAX_BOOT_ATTEMPTS {
            write_marker(&self.state_dir, &marker)?;
            return Ok(());
        }
        let Some(previous) = marker.previous_exe.clone().filter(|p| p.exists()) else {
            tracing::error!(
                version = %marker.version,
                "self-update looks unhealthy but no previous binary is kept — continuing"
            );
            marker.confirmed = true;
            write_marker(&self.state_dir, &marker)?;
            return Ok(());
        };
        tracing::error!(
            version = %marker.version,
            attempts = marker.attempts,
            "self-updated binary never reached a healthy connection — rolling back"
        );
        let exe = std::env::current_exe().context("resolve current_exe for rollback")?;
        let quarantined = exe.with_extension(format!("bad-{}", marker.version));
        let _ = std::fs::remove_file(&quarantined);
        std::fs::rename(&exe, &quarantined).context("quarantine failing binary")?;
        std::fs::rename(&previous, &exe).context("restore previous binary")?;
        if !marker.blocked_versions.contains(&marker.version) {
            marker.blocked_versions.push(marker.version.clone());
        }
        marker.confirmed = true; // the restored binary must not count boots
        marker.previous_exe = None;
        write_marker(&self.state_dir, &marker)?;
        exec_self(&exe)
    }

    /// Health half of the rollback rail: the bridge connected, so the running
    /// binary is good — stop counting boots and drop the kept `.old`.
    pub fn mark_healthy(&self) {
        if self.confirmed.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(mut marker) = read_marker(&self.state_dir) else {
            return;
        };
        if marker.confirmed {
            return;
        }
        marker.confirmed = true;
        if let Some(previous) = marker.previous_exe.take() {
            let _ = std::fs::remove_file(previous);
        }
        if let Err(err) = write_marker(&self.state_dir, &marker) {
            tracing::warn!("failed to confirm self-update marker: {err}");
        } else {
            tracing::info!(version = %marker.version, "self-update confirmed healthy");
        }
    }

    /// Startup half of the notice rail: before any gateway is reachable, replay
    /// the persisted "newer version exists" reminder from the previous run so an
    /// owner reading the boot log knows an update is pending. (`available_update`
    /// self-clears once the binary has caught up.)
    pub fn startup_notice(&self) {
        let Some(notice) = available_update(&self.state_dir) else {
            return;
        };
        if let Some(reason) = self.disabled_reason() {
            self.notice_manual(&notice, reason);
        } else {
            tracing::info!(
                current = current_version(),
                available = %notice.latest,
                "connector update pending — will self-update after connecting"
            );
        }
    }

    /// Warn the owner that a manual update is needed — once per version per
    /// process, so reconnect-time hellos don't turn the reminder into spam.
    fn notice_manual(&self, notice: &AvailableUpdate, reason: &str) {
        let mut noticed = self.noticed.lock().expect("noticed lock poisoned");
        if noticed.as_deref() == Some(notice.latest.as_str()) {
            return;
        }
        *noticed = Some(notice.latest.clone());
        tracing::warn!("{}", notice.manual_hint(reason));
    }

    /// Trigger half: called with the gateway-advertised release version after
    /// every hello. Persists (or clears) the update notice, and spawns at most
    /// one update task per process lifetime when self-update is enabled.
    pub fn maybe_start(self: &Arc<Self>, advertised: String, control_url: String) {
        if !version_is_newer(&advertised, current_version()) {
            // This gateway serves nothing newer — drop any stale reminder (a
            // manual update landed, or the gateway was pinned back).
            let _ = std::fs::remove_file(available_path(&self.state_dir));
            return;
        }
        let notice = AvailableUpdate {
            latest: advertised.clone(),
            download_base: download_base_from_control_url(&control_url),
        };
        if let Err(err) = write_available(&self.state_dir, &notice) {
            tracing::warn!("failed to persist update notice: {err}");
        }
        if let Some(reason) = self.disabled_reason() {
            self.notice_manual(&notice, reason);
            return;
        }
        if let Some(marker) = read_marker(&self.state_dir) {
            if marker.blocked_versions.iter().any(|v| v == &advertised) {
                tracing::warn!(
                    version = %advertised,
                    "skipping self-update: this version was previously rolled back"
                );
                return;
            }
        }
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let updater = self.clone();
        tokio::spawn(async move {
            if let Err(err) = updater.run_update(&advertised, &control_url).await {
                tracing::error!("self-update to {advertised} failed: {err}");
                // Allow a retry on a later reconnect/process restart.
                updater.started.store(false, Ordering::SeqCst);
            }
        });
    }

    async fn run_update(&self, advertised: &str, control_url: &str) -> anyhow::Result<()> {
        let base = download_base_from_control_url(control_url)
            .ok_or_else(|| anyhow!("cannot derive download URL from control_url {control_url}"))?;
        tracing::info!(
            current = current_version(),
            target = %advertised,
            base = %base,
            "self-update: downloading signed manifest"
        );

        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(300))
            .build()?;
        let manifest_bytes = fetch(&client, &format!("{base}/connector-manifest.json")).await?;
        let sig_b64 = String::from_utf8(
            fetch(&client, &format!("{base}/connector-manifest.json.sig")).await?,
        )
        .context("manifest signature is not UTF-8")?;
        let manifest = verify_and_parse_manifest(&manifest_bytes, &sig_b64, self.pubkey_pem())?;

        // The advertised version is an unauthenticated hint; the signed manifest
        // is the truth. Re-check so a stale/lying gateway can't downgrade us.
        if !version_is_newer(&manifest.version, current_version()) {
            return Err(anyhow!(
                "signed manifest is for {} which is not newer than {} — refusing",
                manifest.version,
                current_version()
            ));
        }

        let suffix = platform_asset_suffix().expect("checked in disabled_reason");
        let exe = std::env::current_exe()?;
        let exe_dir = exe
            .parent()
            .ok_or_else(|| anyhow!("current exe has no parent dir"))?
            .to_path_buf();

        // The MCP server ships in lockstep and is resolved next to the connector
        // executable, so when that sibling exists it must be swapped in the same
        // generation — a version-skewed pair is not a supported state.
        let mut wanted: Vec<(String, PathBuf)> =
            vec![(format!("cce-acp-connector-{suffix}"), exe.clone())];
        let mcp_sibling = exe_dir.join("cheers-mcp-server");
        if mcp_sibling.exists() {
            wanted.push((format!("cheers-mcp-server-{suffix}"), mcp_sibling));
        }

        let staging = self
            .state_dir
            .join("self-update")
            .join(format!("staged-{}", manifest.version));
        tokio::fs::create_dir_all(&staging).await?;

        let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new(); // (staged file, install target)
        for (asset, target) in &wanted {
            let expected = &manifest
                .assets
                .get(asset)
                .ok_or_else(|| anyhow!("manifest has no asset {asset}"))?
                .sha256;
            let bytes = fetch(&client, &format!("{base}/{asset}")).await?;
            let actual = sha256_hex(&bytes);
            if &actual != expected {
                return Err(anyhow!(
                    "sha256 mismatch for {asset}: manifest {expected}, downloaded {actual}"
                ));
            }
            let staged_path = staging.join(asset);
            tokio::fs::write(&staged_path, &bytes).await?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                tokio::fs::set_permissions(&staged_path, std::fs::Permissions::from_mode(0o755))
                    .await?;
            }
            staged.push((staged_path, target.clone()));
            tracing::info!(asset = %asset, sha256 = %actual, "self-update: staged");
        }

        // Drain: wait for a quiet connector. Two consecutive zero readings
        // narrow (but can't fully close) the race with a task frame that lands
        // between the check and the exec — an acceptable residue, since the
        // gateway already finalizes orphaned turns as "[bot offline]".
        tracing::info!(version = %manifest.version, "self-update: staged, waiting for idle");
        let mut quiet = 0u32;
        let mut waited = Duration::ZERO;
        loop {
            if active_prompts() == 0 {
                quiet += 1;
                if quiet >= 2 {
                    break;
                }
            } else {
                quiet = 0;
            }
            tokio::time::sleep(DRAIN_POLL).await;
            waited += DRAIN_POLL;
            if waited.as_secs() % 300 == 0 {
                tracing::info!(
                    in_flight = active_prompts(),
                    "self-update: still draining before restart"
                );
            }
        }

        self.apply_and_exec(&manifest.version, &staged)
    }

    /// Swap every staged binary into place and exec the new connector. Copies
    /// into the install dir first (staging may be another filesystem), then
    /// uses two same-directory renames so each swap is atomic; the displaced
    /// binary survives as `<target>.old` until `mark_healthy`.
    fn apply_and_exec(&self, version: &str, staged: &[(PathBuf, PathBuf)]) -> anyhow::Result<()> {
        let exe = std::env::current_exe()?;
        let mut previous_exe = None;
        for (staged_path, target) in staged {
            let incoming = target.with_extension("new");
            std::fs::copy(staged_path, &incoming)
                .with_context(|| format!("copy staged update into {}", incoming.display()))?;
            let old = target.with_extension("old");
            let _ = std::fs::remove_file(&old);
            std::fs::rename(target, &old)
                .with_context(|| format!("set aside {}", target.display()))?;
            std::fs::rename(&incoming, target)
                .with_context(|| format!("install {}", target.display()))?;
            if target == &exe {
                previous_exe = Some(old);
            }
        }
        write_marker(
            &self.state_dir,
            &Marker {
                version: version.to_string(),
                previous_exe,
                attempts: 0,
                confirmed: false,
                blocked_versions: read_marker(&self.state_dir)
                    .map(|m| m.blocked_versions)
                    .unwrap_or_default(),
            },
        )?;
        tracing::info!(version = %version, "self-update: binaries swapped, restarting");
        exec_self(&exe)
    }
}

async fn fetch(client: &reqwest::Client, url: &str) -> anyhow::Result<Vec<u8>> {
    let resp = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("GET {url} returned HTTP {}", resp.status()));
    }
    Ok(resp.bytes().await?.to_vec())
}

/// Replace this process with `exe`, keeping argv (daemon metadata matches on
/// the command line) and the PID (launchd/systemd units keep tracking us).
#[cfg(unix)]
fn exec_self(exe: &Path) -> anyhow::Result<()> {
    use std::os::unix::process::CommandExt;
    let err = std::process::Command::new(exe)
        .args(std::env::args_os().skip(1))
        .exec();
    Err(anyhow!("exec {} failed: {err}", exe.display()))
}

#[cfg(not(unix))]
fn exec_self(_exe: &Path) -> anyhow::Result<()> {
    Err(anyhow!(
        "self-update restart is only supported on unix platforms"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
    use ed25519_dalek::pkcs8::EncodePublicKey;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn version_compare_is_numeric() {
        assert!(version_is_newer("0.1.27", "0.1.26"));
        assert!(version_is_newer("0.1.100", "0.1.26"));
        assert!(version_is_newer("v0.2.0", "0.1.99"));
        assert!(!version_is_newer("0.1.26", "0.1.26"));
        assert!(!version_is_newer("0.1.25", "0.1.26"));
        assert!(!version_is_newer("latest", "0.1.26"));
    }

    #[test]
    fn download_base_derivation() {
        assert_eq!(
            download_base_from_control_url("wss://chat.example.com/ws/agent-bridge/control")
                .as_deref(),
            Some("https://chat.example.com/api/v1/connector/download")
        );
        assert_eq!(
            download_base_from_control_url("ws://localhost:30080/ws/agent-bridge/control")
                .as_deref(),
            Some("http://localhost:30080/api/v1/connector/download")
        );
        assert_eq!(
            download_base_from_control_url("wss://host.example.com/cheers/ws/agent-bridge/control")
                .as_deref(),
            Some("https://host.example.com/cheers/api/v1/connector/download")
        );
        assert_eq!(
            download_base_from_control_url("https://host/ws/agent-bridge/control"),
            None
        );
        assert_eq!(
            download_base_from_control_url("wss://host/other/path"),
            None
        );
    }

    #[test]
    fn manifest_roundtrip_verifies_and_rejects_tampering() {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let pubkey_pem = signing
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .expect("pem");
        let manifest =
            br#"{"version":"0.1.27","assets":{"cce-acp-connector-linux-amd64":{"sha256":"abc"}}}"#;
        let sig_b64 = BASE64.encode(signing.sign(manifest).to_bytes());

        let parsed = verify_and_parse_manifest(manifest, &sig_b64, &pubkey_pem).expect("verify");
        assert_eq!(parsed.version, "0.1.27");

        let mut tampered = manifest.to_vec();
        tampered[12] = b'9'; // version byte
        assert!(verify_and_parse_manifest(&tampered, &sig_b64, &pubkey_pem).is_err());

        let other_key = SigningKey::from_bytes(&[8u8; 32])
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .expect("pem");
        assert!(verify_and_parse_manifest(manifest, &sig_b64, &other_key).is_err());
    }

    #[test]
    fn embedded_pubkey_parses() {
        VerifyingKey::from_public_key_pem(EMBEDDED_RELEASE_PUBKEY)
            .expect("embedded release pubkey must be a valid ed25519 SPKI PEM");
    }

    #[test]
    fn busy_guard_counts() {
        let before = active_prompts();
        {
            let _a = BusyGuard::new();
            let _b = BusyGuard::new();
            assert_eq!(active_prompts(), before + 2);
        }
        assert_eq!(active_prompts(), before);
    }

    #[test]
    fn disabled_update_persists_notice_and_clears_when_caught_up() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state_path = dir.path().join("state.json");
        let updater = SelfUpdater::new(UpdateSettings::default(), &state_path);
        let control = "wss://h.example/ws/agent-bridge/control".to_string();

        // auto=false + newer advertised → no update task, but the notice (with
        // a derived download base) is persisted for startup/status reminders.
        updater.maybe_start("999.0.0".into(), control.clone());
        let notice = available_update(dir.path()).expect("notice persisted");
        assert_eq!(notice.latest, "999.0.0");
        assert_eq!(
            notice.download_base.as_deref(),
            Some("https://h.example/api/v1/connector/download")
        );

        // The gateway no longer advertises anything newer → reminder cleared.
        updater.maybe_start(current_version().into(), control);
        assert!(available_update(dir.path()).is_none());

        // A stale persisted notice (binary caught up meanwhile) self-clears on read.
        write_available(
            dir.path(),
            &AvailableUpdate {
                latest: current_version().into(),
                download_base: None,
            },
        )
        .expect("write notice");
        assert!(available_update(dir.path()).is_none());
        assert!(!available_path(dir.path()).exists());
    }

    #[test]
    fn startup_gate_rolls_back_after_max_attempts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state_dir = dir.path();
        // No marker → no-op.
        let updater = SelfUpdater::new(UpdateSettings::default(), &state_dir.join("state.json"));
        updater.startup_gate().expect("no marker is fine");

        // Pending marker: each gate call burns one attempt.
        write_marker(
            state_dir,
            &Marker {
                version: "9.9.9".into(),
                previous_exe: None,
                attempts: 0,
                confirmed: false,
                blocked_versions: vec![],
            },
        )
        .expect("write marker");
        for expected in 1..=MAX_BOOT_ATTEMPTS {
            updater.startup_gate().expect("counted boot");
            assert_eq!(read_marker(state_dir).unwrap().attempts, expected);
        }
        // Attempts exhausted with no previous binary kept → confirm and continue
        // (nothing to roll back to), rather than dying in a loop.
        updater.startup_gate().expect("continues without previous");
        let marker = read_marker(state_dir).unwrap();
        assert!(marker.confirmed);

        // mark_healthy is idempotent and confirms a fresh pending marker.
        write_marker(
            state_dir,
            &Marker {
                version: "9.9.10".into(),
                previous_exe: None,
                attempts: 1,
                confirmed: false,
                blocked_versions: vec![],
            },
        )
        .expect("write marker");
        let updater = SelfUpdater::new(UpdateSettings::default(), &state_dir.join("state.json"));
        updater.mark_healthy();
        assert!(read_marker(state_dir).unwrap().confirmed);
    }
}
