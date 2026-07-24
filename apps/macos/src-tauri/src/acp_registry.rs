//! ACP Registry client for the desktop shell (npx + uvx + binary catalog).
//!
//! Same JSON as the gateway (`cdn.agentclientprotocol.com/.../registry.json`).
//! Keep in sync with `server/src/domain/acp_registry.rs`.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;

const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistKind {
    Npx,
    Uvx,
}

#[derive(Debug, Clone)]
pub struct PackageLaunch {
    pub id: String,
    pub name: String,
    #[allow(dead_code)]
    pub version: String,
    pub package: String,
    pub args: Vec<String>,
    #[allow(dead_code)]
    pub env_keys: Vec<String>,
    pub kind: DistKind,
}

#[derive(Debug, Clone)]
pub struct BinaryTarget {
    pub archive: String,
    pub cmd: String,
    pub args: Vec<String>,
    #[allow(dead_code)]
    pub env_keys: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct BinaryLaunch {
    pub id: String,
    pub name: String,
    #[allow(dead_code)]
    pub version: String,
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

#[derive(Debug, Default, Clone)]
struct RegistryCache {
    fetched_at: Option<Instant>,
    packages: HashMap<String, PackageLaunch>,
    binaries: HashMap<String, BinaryLaunch>,
}

static CACHE: LazyLock<Mutex<RegistryCache>> =
    LazyLock::new(|| Mutex::new(RegistryCache::default()));

pub fn package_name_unversioned(spec: &str) -> String {
    let spec = spec.trim();
    if let Some((name, _)) = spec.split_once("==") {
        return name.to_string();
    }
    if let Some(idx) = spec.rfind('@') {
        if idx > 0 {
            return spec[..idx].to_string();
        }
    }
    spec.to_string()
}

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
        "@agentclientprotocol/claude-agent-acp" => "claude-agent-acp".into(),
        "@agentclientprotocol/codex-acp" => "codex-acp".into(),
        _ => base.to_string(),
    }
}

pub fn bin_name_from_cmd(cmd: &str) -> String {
    let trimmed = cmd.trim().trim_start_matches("./").replace('\\', "/");
    let base = trimmed.rsplit('/').next().unwrap_or(&trimmed);
    base.trim_end_matches(".cmd")
        .trim_end_matches(".exe")
        .to_string()
}

pub fn adapter_command_for(launch: &PackageLaunch) -> String {
    match launch.kind {
        DistKind::Npx => infer_bin_name(&launch.package),
        DistKind::Uvx => "uvx".into(),
    }
}

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

pub fn cheers_key_for(registry_id: &str) -> String {
    match registry_id {
        "claude-acp" => "claude".into(),
        "codex-acp" => "codex".into(),
        other => other.to_string(),
    }
}

pub fn host_platform() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-aarch64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x86_64"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
    )))]
    {
        "unknown"
    }
}

pub fn binary_target_for_host(launch: &BinaryLaunch) -> Option<&BinaryTarget> {
    launch.targets.get(host_platform())
}

pub fn parse_registry_json(raw: &str) -> Result<ParsedRegistry, String> {
    let file: RegistryFile =
        serde_json::from_str(raw).map_err(|e| format!("registry json: {e}"))?;
    let mut packages = HashMap::new();
    let mut binaries = HashMap::new();
    for agent in file.agents {
        if let Some(npx) = agent.distribution.npx {
            if !npx.package.trim().is_empty() {
                packages.insert(
                    agent.id.clone(),
                    PackageLaunch {
                        id: agent.id.clone(),
                        name: agent.name.clone(),
                        version: agent.version.clone(),
                        package: npx.package,
                        args: npx.args,
                        env_keys: npx.env.keys().cloned().collect(),
                        kind: DistKind::Npx,
                    },
                );
                continue;
            }
        }
        if let Some(uvx) = agent.distribution.uvx {
            if !uvx.package.trim().is_empty() {
                packages.insert(
                    agent.id.clone(),
                    PackageLaunch {
                        id: agent.id.clone(),
                        name: agent.name.clone(),
                        version: agent.version.clone(),
                        package: uvx.package,
                        args: uvx.args,
                        env_keys: uvx.env.keys().cloned().collect(),
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
        .user_agent(concat!("cheers-desktop/", env!("CARGO_PKG_VERSION")))
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
        Err(p) => p.into_inner(),
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
        Err(_) => guard.clone(),
    }
}

pub fn list_package_agents() -> Vec<PackageLaunch> {
    let mut list: Vec<_> = cache_snapshot().packages.into_values().collect();
    list.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    list
}

pub fn list_binary_agents() -> Vec<BinaryLaunch> {
    let mut list: Vec<_> = cache_snapshot().binaries.into_values().collect();
    list.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    list
}

pub fn package_launch_by_cheers_key(key: &str) -> Option<PackageLaunch> {
    let map = cache_snapshot().packages;
    let registry_id = match key {
        "claude" => "claude-acp",
        "codex" => "codex-acp",
        other => other,
    };
    map.get(registry_id).cloned()
}

pub fn binary_launch_by_cheers_key(key: &str) -> Option<BinaryLaunch> {
    cache_snapshot().binaries.get(key).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_versions_and_infers_bins() {
        assert_eq!(
            package_name_unversioned("@google/gemini-cli@0.52.0"),
            "@google/gemini-cli"
        );
        assert_eq!(infer_bin_name("@google/gemini-cli@0.52.0"), "gemini");
        assert_eq!(
            bin_name_from_cmd("./dist-package/cursor-agent"),
            "cursor-agent"
        );
        assert_eq!(cheers_key_for("claude-acp"), "claude");
    }

    #[test]
    fn parses_npx_uvx_and_binary() {
        let parsed = parse_registry_json(
            r#"{
              "agents": [
                {
                  "id": "gemini",
                  "name": "Gemini CLI",
                  "distribution": {
                    "npx": {
                      "package": "@google/gemini-cli@0.52.0",
                      "args": ["--acp"]
                    }
                  }
                },
                {
                  "id": "fast-agent",
                  "name": "fast-agent",
                  "distribution": {
                    "uvx": {
                      "package": "fast-agent-acp==0.9.22",
                      "args": ["-x"]
                    }
                  }
                },
                {
                  "id": "cursor",
                  "name": "Cursor",
                  "distribution": {
                    "binary": {
                      "darwin-aarch64": {
                        "archive": "https://example.com/c.tgz",
                        "cmd": "./dist-package/cursor-agent",
                        "args": ["acp"]
                      }
                    }
                  }
                }
              ]
            }"#,
        )
        .unwrap();
        assert_eq!(parsed.packages.len(), 2);
        assert_eq!(parsed.binaries.len(), 1);
        assert!(parsed.binaries.contains_key("cursor"));
    }
}
