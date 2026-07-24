//! ACP Registry client — dynamic agent catalog for connector config presets.
//!
//! Source of truth: `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
//! (see https://agentclientprotocol.com/get-started/registry). Cheers prefers
//! **npx-distributed** agents for one-click install; binary/uvx entries are
//! parsed but not offered as first-class presets yet.
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

/// How to launch an npx-distributed ACP agent after `npm install -g <package>`.
#[derive(Debug, Clone)]
pub struct NpxLaunch {
    pub id: String,
    pub name: String,
    pub version: String,
    /// Full npm package spec, possibly version-pinned (`pkg@1.2.3`).
    pub package: String,
    /// Argv after the package binary (e.g. `["--acp"]`, `["acp"]`).
    pub args: Vec<String>,
    /// Extra env keys the agent documents (values are hints; we only *allow*
    /// the keys through the connector's env filter).
    pub env_keys: Vec<String>,
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
    // binary / uvx intentionally ignored for the npx-first rollout.
}

#[derive(Debug, Clone, Deserialize)]
struct PackageDist {
    package: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

#[derive(Debug, Clone, Default)]
struct RegistryCache {
    fetched_at: Option<Instant>,
    /// id → launch
    by_id: HashMap<String, NpxLaunch>,
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

/// Strip a trailing `@version` from an npm package spec, preserving scopes.
/// `@scope/pkg@1.2.3` → `@scope/pkg`; `pkg@1.2.3` → `pkg`.
pub fn package_name_unversioned(spec: &str) -> String {
    let spec = spec.trim();
    if let Some(idx) = spec.rfind('@') {
        // Scoped packages start with '@'; only strip when a *second* '@' marks the version.
        if idx > 0 {
            return spec[..idx].to_string();
        }
    }
    spec.to_string()
}

/// Best-effort binary name for a global npm install of `spec`.
/// Last path segment of the unversioned package (`@scope/foo-bar` → `foo-bar`),
/// with a few known overrides where the published bin differs.
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

/// Parse a registry JSON body into npx launches keyed by agent id.
pub fn parse_registry_json(raw: &str) -> Result<HashMap<String, NpxLaunch>, String> {
    let file: RegistryFile =
        serde_json::from_str(raw).map_err(|e| format!("registry json: {e}"))?;
    let mut out = HashMap::new();
    for agent in file.agents {
        let Some(npx) = agent.distribution.npx else {
            continue;
        };
        if npx.package.trim().is_empty() {
            continue;
        }
        let env_keys: Vec<String> = npx.env.keys().cloned().collect();
        out.insert(
            agent.id.clone(),
            NpxLaunch {
                id: agent.id,
                name: agent.name,
                version: agent.version,
                package: npx.package,
                args: npx.args,
                env_keys,
            },
        );
    }
    Ok(out)
}

fn fetch_registry_blocking() -> Result<HashMap<String, NpxLaunch>, String> {
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

fn cache_get() -> HashMap<String, NpxLaunch> {
    let mut guard = match CACHE.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
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
        Err(e) => {
            tracing::warn!(error = %e, "ACP registry fetch failed; using cached/empty");
            guard.by_id.clone()
        }
    }
}

/// Look up an npx launch by Cheers agent id or legacy short name.
pub fn npx_launch_for(agent_type: &str) -> Option<NpxLaunch> {
    let id = canonicalize_agent_id(agent_type);
    let map = cache_get();
    map.get(&id).cloned()
}

/// All cached npx agents (triggers a fetch on cold cache). Sorted by name.
pub fn list_npx_agents() -> Vec<NpxLaunch> {
    let mut list: Vec<_> = cache_get().into_values().collect();
    list.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    list
}

/// Seed the cache from JSON (tests / offline inject). Replaces any prior entry.
#[cfg(test)]
pub fn seed_cache_for_test(raw: &str) {
    let map = parse_registry_json(raw).expect("fixture");
    let mut guard = CACHE.lock().unwrap();
    guard.fetched_at = Some(Instant::now());
    guard.by_id = map;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_npm_versions_and_scopes() {
        assert_eq!(
            package_name_unversioned("@agentclientprotocol/claude-agent-acp@0.61.0"),
            "@agentclientprotocol/claude-agent-acp"
        );
        assert_eq!(package_name_unversioned("cline@3.0.46"), "cline");
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
    }

    #[test]
    fn parses_npx_agents_only() {
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
              "id": "goose",
              "name": "goose",
              "version": "1.0.0",
              "distribution": { "binary": { "darwin-aarch64": { "archive": "https://x", "cmd": "./goose" } } }
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
            }
          ]
        }"#;
        let map = parse_registry_json(raw).unwrap();
        assert_eq!(map.len(), 2);
        assert!(map.contains_key("claude-acp"));
        assert!(!map.contains_key("goose"));
        let g = map.get("gemini").unwrap();
        assert_eq!(g.args, vec!["--acp"]);
        assert_eq!(g.env_keys, vec!["FOO"]);
    }

    #[test]
    fn canonicalize_legacy_short_names() {
        assert_eq!(canonicalize_agent_id("Claude"), "claude-acp");
        assert_eq!(canonicalize_agent_id("codex"), "codex-acp");
        assert_eq!(canonicalize_agent_id("gemini"), "gemini");
    }
}
