//! ACP Registry client for the desktop shell (npx + uvx agent catalog).
//!
//! Same JSON as the gateway (`cdn.agentclientprotocol.com/.../registry.json`).
//! Desktop uses it to detect/install agents; the gateway uses it to render
//! connector TOML. Keep the parse helpers in sync with
//! `server/src/domain/acp_registry.rs`.

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
    #[allow(dead_code)] // kept for UI / update checks later
    pub version: String,
    pub package: String,
    pub args: Vec<String>,
    #[allow(dead_code)] // gateway mirrors this into env_allow
    pub env_keys: Vec<String>,
    pub kind: DistKind,
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
}

#[derive(Debug, Clone, Deserialize)]
struct PackageDist {
    package: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

#[derive(Debug, Default)]
struct RegistryCache {
    fetched_at: Option<Instant>,
    by_id: HashMap<String, PackageLaunch>,
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

/// Cheers UI key for a registry agent. Builtins keep short ids for existing bots.
pub fn cheers_key_for(registry_id: &str) -> String {
    match registry_id {
        "claude-acp" => "claude".into(),
        "codex-acp" => "codex".into(),
        other => other.to_string(),
    }
}

pub fn parse_registry_json(raw: &str) -> Result<HashMap<String, PackageLaunch>, String> {
    let file: RegistryFile =
        serde_json::from_str(raw).map_err(|e| format!("registry json: {e}"))?;
    let mut out = HashMap::new();
    for agent in file.agents {
        let (kind, dist) = match (agent.distribution.npx, agent.distribution.uvx) {
            (Some(npx), _) => (DistKind::Npx, npx),
            (None, Some(uvx)) => (DistKind::Uvx, uvx),
            (None, None) => continue,
        };
        if dist.package.trim().is_empty() {
            continue;
        }
        let env_keys: Vec<String> = dist.env.keys().cloned().collect();
        out.insert(
            agent.id.clone(),
            PackageLaunch {
                id: agent.id,
                name: agent.name,
                version: agent.version,
                package: dist.package,
                args: dist.args,
                env_keys,
                kind,
            },
        );
    }
    Ok(out)
}

fn fetch_registry_blocking() -> Result<HashMap<String, PackageLaunch>, String> {
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

fn cache_get() -> HashMap<String, PackageLaunch> {
    let mut guard = match CACHE.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    if let Some(at) = guard.fetched_at {
        if at.elapsed() < CACHE_TTL && !guard.by_id.is_empty() {
            return guard.by_id.clone();
        }
    }
    match fetch_registry_blocking() {
        Ok(map) => {
            guard.fetched_at = Some(Instant::now());
            guard.by_id = map.clone();
            map
        }
        Err(_) => guard.by_id.clone(),
    }
}

pub fn list_package_agents() -> Vec<PackageLaunch> {
    let mut list: Vec<_> = cache_get().into_values().collect();
    list.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    list
}

pub fn package_launch_by_cheers_key(key: &str) -> Option<PackageLaunch> {
    let map = cache_get();
    let registry_id = match key {
        "claude" => "claude-acp",
        "codex" => "codex-acp",
        other => other,
    };
    map.get(registry_id).cloned()
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
        assert_eq!(
            package_name_unversioned("fast-agent-acp==0.9.22"),
            "fast-agent-acp"
        );
        assert_eq!(infer_bin_name("@google/gemini-cli@0.52.0"), "gemini");
        assert_eq!(cheers_key_for("claude-acp"), "claude");
    }

    #[test]
    fn parses_npx_and_uvx() {
        let map = parse_registry_json(
            r#"{
              "agents": [
                {
                  "id": "gemini",
                  "name": "Gemini CLI",
                  "version": "0.52.0",
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
                  "distribution": { "binary": {} }
                }
              ]
            }"#,
        )
        .unwrap();
        assert_eq!(map.len(), 2);
        assert_eq!(map["gemini"].args, vec!["--acp"]);
        assert_eq!(map["fast-agent"].kind, DistKind::Uvx);
        assert_eq!(adapter_command_for(&map["fast-agent"]), "uvx");
        assert!(!map.contains_key("cursor"));
    }
}
