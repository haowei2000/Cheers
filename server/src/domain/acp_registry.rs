//! ACP Registry client — dynamic agent catalog for connector config presets.
//!
//! Source of truth: `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
//! (see https://agentclientprotocol.com/get-started/registry). Cheers offers
//! **npx**, **uvx**, and **binary** distributions for one-click setup.
//! Prefer package managers when an agent advertises both.
//!
//! Network is best-effort: a cache miss or fetch failure falls back to the
//! hardcoded Claude/Codex/OpenCode presets in `connector_config`. Tests never
//! hit the network — they use [`parse_registry_json`] on fixtures.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;

const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);

/// How an agent is distributed via a package manager (`npx` or `uvx`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistKind {
    Npx,
    Uvx,
}

impl DistKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DistKind::Npx => "npx",
            DistKind::Uvx => "uvx",
        }
    }
}

/// Launch recipe for an npx/uvx ACP agent after the package tooling is available.
#[derive(Debug, Clone)]
pub struct PackageLaunch {
    pub id: String,
    pub name: String,
    pub version: String,
    /// Full package spec (npm `@scope/pkg@1.2.3` or PyPI `pkg==1.2.3` / `pkg@1.2.3`).
    pub package: String,
    /// Argv after the launcher (npx: after the bin; uvx: after the package).
    pub args: Vec<String>,
    /// Extra env keys the agent documents (values are hints; we only *allow*
    /// the keys through the connector's env filter).
    pub env_keys: Vec<String>,
    pub kind: DistKind,
}

/// Platform-specific binary download + launch recipe.
#[derive(Debug, Clone)]
pub struct BinaryTarget {
    pub archive: String,
    /// Relative command after extract (e.g. `./dist-package/cursor-agent`).
    pub cmd: String,
    pub args: Vec<String>,
    pub env_keys: Vec<String>,
}

/// Binary-distributed ACP agent (Cursor, goose, …).
#[derive(Debug, Clone)]
pub struct BinaryLaunch {
    pub id: String,
    pub name: String,
    pub version: String,
    /// Platform id → target (`darwin-aarch64`, …).
    pub targets: HashMap<String, BinaryTarget>,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedRegistry {
    pub packages: HashMap<String, PackageLaunch>,
    pub binaries: HashMap<String, BinaryLaunch>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RegistryFile {
    #[serde(default)]
    agents: Vec<RegistryAgent>,
}

#[derive(Debug, Clone, Deserialize)]
struct RegistryAgent {
    id: String,
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    distribution: Distribution,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct Distribution {
    #[serde(default)]
    npx: Option<PackageDist>,
    #[serde(default)]
    uvx: Option<PackageDist>,
    #[serde(default)]
    binary: Option<HashMap<String, BinaryDist>>,
}

#[derive(Debug, Clone, Deserialize)]
struct PackageDist {
    package: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
struct BinaryDist {
    archive: String,
    cmd: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

#[derive(Debug, Clone, Default)]
struct RegistryCache {
    fetched_at: Option<Instant>,
    packages: HashMap<String, PackageLaunch>,
    binaries: HashMap<String, BinaryLaunch>,
}

static CACHE: LazyLock<Mutex<RegistryCache>> =
    LazyLock::new(|| Mutex::new(RegistryCache::default()));

/// Legacy Cheers short names → registry ids (and vice-versa for lookup).
pub fn canonicalize_agent_id(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "claude" => "claude-acp".into(),
        "codex" => "codex-acp".into(),
        other => other.to_string(),
    }
}

/// Strip a trailing version from an npm (`@ver`) or PyPI (`==ver` / `@ver`) spec.
pub fn package_name_unversioned(spec: &str) -> String {
    let spec = spec.trim();
    if let Some((name, _)) = spec.split_once("==") {
        return name.to_string();
    }
    if let Some(idx) = spec.rfind('@') {
        // Scoped npm packages start with '@'; only strip when a *second* '@' marks the version.
        if idx > 0 {
            return spec[..idx].to_string();
        }
    }
    spec.to_string()
}

/// Best-effort binary name for a global npm install of `spec`.
pub fn infer_bin_name(package_spec: &str) -> String {
    let pkg = package_name_unversioned(package_spec);
    let base = pkg.rsplit('/').next().unwrap_or(&pkg);
    match pkg.as_str() {
        "@google/gemini-cli" => "gemini".into(),
        "@github/copilot" => "copilot".into(),
        "@xai-official/grok" => "grok".into(),
        "@qwen-code/qwen-code" => "qwen".into(),
        "@qoder-ai/qodercli" => "qoder".into(),
        "@tencent-ai/codebuddy-code" => "codebuddy".into(),
        "@kilocode/cli" => "kilo".into(),
        "@compass-ai/nova" => "nova".into(),
        "@augmentcode/auggie" => "auggie".into(),
        "@autohandai/autohand-acp" => "autohand-acp".into(),
        _ => base.to_string(),
    }
}

/// Basename of a registry binary `cmd` (`./dist-package/cursor-agent` → `cursor-agent`).
pub fn bin_name_from_cmd(cmd: &str) -> String {
    let trimmed = cmd.trim().trim_start_matches("./").replace('\\', "/");
    let base = trimmed.rsplit('/').next().unwrap_or(&trimmed);
    base.trim_end_matches(".cmd")
        .trim_end_matches(".exe")
        .to_string()
}

/// Adapter argv for a package launch: npx → registry args; uvx → `[package, …args]`.
pub fn adapter_args_for(launch: &PackageLaunch) -> Vec<String> {
    match launch.kind {
        DistKind::Npx => launch.args.clone(),
        DistKind::Uvx => {
            let mut args = vec![launch.package.clone()];
            args.extend(launch.args.iter().cloned());
            args
        }
    }
}

/// `adapter.command` for a package launch (`gemini` / `claude-agent-acp` / `uvx`).
pub fn adapter_command_for(launch: &PackageLaunch) -> String {
    match launch.kind {
        DistKind::Npx => infer_bin_name(&launch.package),
        DistKind::Uvx => "uvx".into(),
    }
}

/// Pick a representative binary target for gateway presets (no client OS).
/// Prefer Apple Silicon, then any darwin, then any listed.
pub fn representative_binary_target(launch: &BinaryLaunch) -> Option<&BinaryTarget> {
    const PREFER: &[&str] = &[
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-x86_64",
        "linux-aarch64",
    ];
    for key in PREFER {
        if let Some(t) = launch.targets.get(*key) {
            return Some(t);
        }
    }
    launch.targets.values().next()
}

/// Host platform id matching the ACP registry (`darwin-aarch64`, …).
pub fn host_platform() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-aarch64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x86_64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-aarch64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x86_64"
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        "windows-aarch64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x86_64"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64"),
    )))]
    {
        "unknown"
    }
}

pub fn binary_target_for_host(launch: &BinaryLaunch) -> Option<&BinaryTarget> {
    launch.targets.get(host_platform())
}

/// Parse a registry JSON body. Prefer **npx** then **uvx** over **binary**.
pub fn parse_registry_json(raw: &str) -> Result<ParsedRegistry, String> {
    let file: RegistryFile =
        serde_json::from_str(raw).map_err(|e| format!("registry json: {e}"))?;
    let mut packages = HashMap::new();
    let mut binaries = HashMap::new();
    for agent in file.agents {
        if let Some(npx) = agent.distribution.npx {
            if !npx.package.trim().is_empty() {
                let env_keys: Vec<String> = npx.env.keys().cloned().collect();
                packages.insert(
                    agent.id.clone(),
                    PackageLaunch {
                        id: agent.id.clone(),
                        name: agent.name.clone(),
                        version: agent.version.clone(),
                        package: npx.package,
                        args: npx.args,
                        env_keys,
                        kind: DistKind::Npx,
                    },
                );
                continue;
            }
        }
        if let Some(uvx) = agent.distribution.uvx {
            if !uvx.package.trim().is_empty() {
                let env_keys: Vec<String> = uvx.env.keys().cloned().collect();
                packages.insert(
                    agent.id.clone(),
                    PackageLaunch {
                        id: agent.id.clone(),
                        name: agent.name.clone(),
                        version: agent.version.clone(),
                        package: uvx.package,
                        args: uvx.args,
                        env_keys,
                        kind: DistKind::Uvx,
                    },
                );
                continue;
            }
        }
        if let Some(raw_targets) = agent.distribution.binary {
            let mut targets = HashMap::new();
            for (platform, dist) in raw_targets {
                if dist.archive.trim().is_empty() || dist.cmd.trim().is_empty() {
                    continue;
                }
                targets.insert(
                    platform,
                    BinaryTarget {
                        archive: dist.archive,
                        cmd: dist.cmd,
                        args: dist.args,
                        env_keys: dist.env.keys().cloned().collect(),
                    },
                );
            }
            if !targets.is_empty() {
                binaries.insert(
                    agent.id.clone(),
                    BinaryLaunch {
                        id: agent.id,
                        name: agent.name,
                        version: agent.version,
                        targets,
                    },
                );
            }
        }
    }
    Ok(ParsedRegistry { packages, binaries })
}

fn fetch_registry_blocking() -> Result<ParsedRegistry, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(concat!("cheers-gateway/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(REGISTRY_URL).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("registry HTTP {}", resp.status()));
    }
    let body = resp.text().map_err(|e| e.to_string())?;
    parse_registry_json(&body)
}

fn cache_snapshot() -> RegistryCache {
    let mut guard = match CACHE.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(at) = guard.fetched_at {
        if at.elapsed() < CACHE_TTL && (!guard.packages.is_empty() || !guard.binaries.is_empty()) {
            return guard.clone();
        }
    }
    match fetch_registry_blocking() {
        Ok(parsed) => {
            guard.fetched_at = Some(Instant::now());
            guard.packages = parsed.packages;
            guard.binaries = parsed.binaries;
            guard.clone()
        }
        Err(e) => {
            tracing::warn!(error = %e, "ACP registry fetch failed; using cached/empty");
            guard.clone()
        }
    }
}

/// Look up a package launch by Cheers agent id or legacy short name.
pub fn package_launch_for(agent_type: &str) -> Option<PackageLaunch> {
    let id = canonicalize_agent_id(agent_type);
    cache_snapshot().packages.get(&id).cloned()
}

/// Look up a binary launch by Cheers agent id.
pub fn binary_launch_for(agent_type: &str) -> Option<BinaryLaunch> {
    let id = canonicalize_agent_id(agent_type);
    cache_snapshot().binaries.get(&id).cloned()
}

/// All cached npx/uvx agents (triggers a fetch on cold cache). Sorted by name.
pub fn list_package_agents() -> Vec<PackageLaunch> {
    let mut list: Vec<_> = cache_snapshot().packages.into_values().collect();
    list.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    list
}

/// All cached binary-only agents. Sorted by name.
pub fn list_binary_agents() -> Vec<BinaryLaunch> {
    let mut list: Vec<_> = cache_snapshot().binaries.into_values().collect();
    list.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    list
}

/// Seed the cache from JSON (tests / offline inject). Replaces any prior entry.
/// Tests that call this must hold [`test_registry_lock`] so parallel cases don't
/// clobber each other's fixtures.
#[cfg(test)]
pub fn seed_cache_for_test(raw: &str) {
    let parsed = parse_registry_json(raw).expect("fixture");
    let mut guard = CACHE.lock().unwrap();
    guard.fetched_at = Some(Instant::now());
    guard.packages = parsed.packages;
    guard.binaries = parsed.binaries;
}

/// Serialize registry-seeded tests (they share process-wide CACHE).
#[cfg(test)]
pub fn test_registry_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_npm_and_pip_versions() {
        assert_eq!(
            package_name_unversioned("@agentclientprotocol/claude-agent-acp@0.61.0"),
            "@agentclientprotocol/claude-agent-acp"
        );
        assert_eq!(package_name_unversioned("cline@3.0.46"), "cline");
        assert_eq!(
            package_name_unversioned("fast-agent-acp==0.9.22"),
            "fast-agent-acp"
        );
        assert_eq!(package_name_unversioned("plain"), "plain");
    }

    #[test]
    fn infers_bin_with_overrides() {
        assert_eq!(
            infer_bin_name("@agentclientprotocol/claude-agent-acp@0.61.0"),
            "claude-agent-acp"
        );
        assert_eq!(infer_bin_name("@google/gemini-cli@0.52.0"), "gemini");
        assert_eq!(infer_bin_name("cline@3.0.46"), "cline");
        assert_eq!(
            bin_name_from_cmd("./dist-package/cursor-agent"),
            "cursor-agent"
        );
    }

    #[test]
    fn parses_npx_uvx_and_binary() {
        let raw = r#"{
          "version": 1,
          "agents": [
            {
              "id": "claude-acp",
              "name": "Claude Agent",
              "version": "0.61.0",
              "distribution": {
                "npx": { "package": "@agentclientprotocol/claude-agent-acp@0.61.0" }
              }
            },
            {
              "id": "cursor",
              "name": "Cursor",
              "version": "1.0.0",
              "distribution": {
                "binary": {
                  "darwin-aarch64": {
                    "archive": "https://example.com/cursor.tgz",
                    "cmd": "./dist-package/cursor-agent",
                    "args": ["acp"]
                  }
                }
              }
            },
            {
              "id": "gemini",
              "name": "Gemini CLI",
              "version": "0.52.0",
              "distribution": {
                "npx": {
                  "package": "@google/gemini-cli@0.52.0",
                  "args": ["--acp"],
                  "env": { "FOO": "1" }
                }
              }
            },
            {
              "id": "fast-agent",
              "name": "fast-agent",
              "version": "0.9.22",
              "distribution": {
                "uvx": {
                  "package": "fast-agent-acp==0.9.22",
                  "args": ["-x"]
                }
              }
            },
            {
              "id": "kilo",
              "name": "Kilo",
              "distribution": {
                "npx": { "package": "@kilocode/cli@1.0.0", "args": ["acp"] },
                "binary": {
                  "darwin-aarch64": { "archive": "https://x", "cmd": "./kilo" }
                }
              }
            }
          ]
        }"#;
        let parsed = parse_registry_json(raw).unwrap();
        assert_eq!(parsed.packages.len(), 4); // claude, gemini, fast-agent, kilo (npx wins)
        assert_eq!(parsed.binaries.len(), 1);
        assert!(parsed.binaries.contains_key("cursor"));
        assert!(!parsed.binaries.contains_key("kilo"));
        let c = &parsed.binaries["cursor"];
        let t = representative_binary_target(c).unwrap();
        assert_eq!(bin_name_from_cmd(&t.cmd), "cursor-agent");
        assert_eq!(t.args, vec!["acp"]);
    }

    #[test]
    fn prefers_npx_when_both_present() {
        let parsed = parse_registry_json(
            r#"{
              "agents": [{
                "id": "both",
                "name": "Both",
                "distribution": {
                  "npx": { "package": "npx-pkg" },
                  "uvx": { "package": "uvx-pkg" }
                }
              }]
            }"#,
        )
        .unwrap();
        assert_eq!(parsed.packages["both"].kind, DistKind::Npx);
        assert_eq!(parsed.packages["both"].package, "npx-pkg");
    }

    #[test]
    fn canonicalize_legacy_short_names() {
        assert_eq!(canonicalize_agent_id("Claude"), "claude-acp");
        assert_eq!(canonicalize_agent_id("codex"), "codex-acp");
        assert_eq!(canonicalize_agent_id("gemini"), "gemini");
    }
}
