//! ACP Registry parsing and launch recipes shared by the Cheers gateway and the
//! desktop shell, so both read the registry the same way.
//!
//! Source of truth: `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
//! (see https://agentclientprotocol.com/get-started/registry). Cheers offers
//! **npx**, **uvx**, and **binary** distributions for one-click setup and
//! prefers package managers when an agent advertises both.
//!
//! The crate does no I/O: each consumer fetches the body with its own HTTP
//! client and hands it to [`RegistryCache::snapshot`].

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::Deserialize;

pub const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
pub const CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(8);

/// Cheers short names for agents whose ACP registry id differs.
const SHORT_NAMES: &[(&str, &str)] = &[("claude", "claude-acp"), ("codex", "codex-acp")];

/// Agents setup UIs list first, in this order; the rest sort by name.
pub const FEATURED_AGENTS: &[&str] = &["claude", "codex", "opencode", "cursor"];

/// The ACP registry id for a Cheers agent key (`claude` → `claude-acp`).
pub fn registry_id_for(key: &str) -> &str {
    SHORT_NAMES
        .iter()
        .find(|(short, _)| *short == key)
        .map_or(key, |(_, id)| id)
}

/// The Cheers agent key for an ACP registry id (`claude-acp` → `claude`).
pub fn cheers_key_for(registry_id: &str) -> &str {
    SHORT_NAMES
        .iter()
        .find(|(_, id)| *id == registry_id)
        .map_or(registry_id, |(short, _)| short)
}

/// Sort rank for setup UIs: featured agents first, then everything else.
pub fn featured_rank(key: &str) -> usize {
    FEATURED_AGENTS
        .iter()
        .position(|k| *k == key)
        .unwrap_or(FEATURED_AGENTS.len())
}

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

/// The version part of an npm spec (`@scope/pkg@1.2.3` → `1.2.3`), if pinned.
pub fn package_version(spec: &str) -> Option<&str> {
    let spec = spec.trim();
    let idx = spec.rfind('@').filter(|idx| *idx > 0)?;
    Some(&spec[idx + 1..]).filter(|v| !v.is_empty())
}

/// The package name without its npm scope (`@scope/pkg@1` → `pkg`). npm uses
/// it as the command name for a string `bin`, and npx prefers the `bin` entry
/// with this name.
pub fn unscoped_package_name(spec: &str) -> String {
    let pkg = package_name_unversioned(spec);
    pkg.rsplit('/').next().unwrap_or(&pkg).to_string()
}

/// npm registry URL of the manifest for exactly this spec (`latest` if unpinned).
pub fn npm_manifest_url(spec: &str) -> String {
    format!(
        "https://registry.npmjs.org/{}/{}",
        package_name_unversioned(spec),
        package_version(spec).unwrap_or("latest")
    )
}

/// The command an npm package installs, per its manifest `bin` field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NpmBin {
    Command(String),
    /// Several commands for different files, none named after the package.
    Ambiguous(Vec<String>),
    /// The package installs no command.
    Missing,
}

/// Reads the command from an npm manifest (registry version document or an
/// installed `package.json`). Follows npx: a single entry, else the entry named
/// after the unscoped package. Entries that all point at one file are aliases,
/// so the shortest name is taken.
pub fn parse_npm_bin(spec: &str, manifest: &str) -> Result<NpmBin, String> {
    let manifest: serde_json::Value =
        serde_json::from_str(manifest).map_err(|e| format!("npm manifest json: {e}"))?;
    let name = unscoped_package_name(spec);
    let bins: Vec<(String, String)> = match manifest.get("bin") {
        Some(serde_json::Value::String(path)) => vec![(name.clone(), path.clone())],
        Some(serde_json::Value::Object(map)) => map
            .iter()
            .filter_map(|(cmd, path)| Some((cmd.clone(), path.as_str()?.to_string())))
            .collect(),
        _ => vec![],
    };
    if let [(cmd, _)] = bins.as_slice() {
        return Ok(NpmBin::Command(cmd.clone()));
    }
    if bins.iter().any(|(cmd, _)| *cmd == name) {
        return Ok(NpmBin::Command(name));
    }
    let target = |path: &str| path.trim_start_matches("./").to_string();
    let Some((_, first)) = bins.first() else {
        return Ok(NpmBin::Missing);
    };
    if bins.iter().all(|(_, path)| target(path) == target(first)) {
        let alias = bins
            .iter()
            .map(|(cmd, _)| cmd)
            .min_by_key(|cmd| (cmd.len(), cmd.as_str()))
            .expect("non-empty");
        return Ok(NpmBin::Command(alias.clone()));
    }
    let mut cmds: Vec<String> = bins.into_iter().map(|(cmd, _)| cmd).collect();
    cmds.sort();
    Ok(NpmBin::Ambiguous(cmds))
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
/// `npm_bin` is the npm manifest's answer, or `None` when it could not be read;
/// the unscoped package name then stands in. Returns `None` when the manifest
/// leaves the command unclear.
pub fn adapter_command_for(launch: &PackageLaunch, npm_bin: Option<&NpmBin>) -> Option<String> {
    match launch.kind {
        DistKind::Uvx => Some("uvx".into()),
        DistKind::Npx => match npm_bin {
            Some(NpmBin::Command(cmd)) => Some(cmd.clone()),
            Some(NpmBin::Ambiguous(_) | NpmBin::Missing) => None,
            None => Some(unscoped_package_name(&launch.package)),
        },
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

impl ParsedRegistry {
    pub fn is_empty(&self) -> bool {
        self.packages.is_empty() && self.binaries.is_empty()
    }

    /// npx/uvx agents sorted by name.
    pub fn packages_by_name(&self) -> Vec<PackageLaunch> {
        sorted_by_name(self.packages.values().cloned().collect(), |l| &l.name)
    }

    /// Binary-only agents sorted by name.
    pub fn binaries_by_name(&self) -> Vec<BinaryLaunch> {
        sorted_by_name(self.binaries.values().cloned().collect(), |l| &l.name)
    }
}

fn sorted_by_name<T>(mut list: Vec<T>, name: impl Fn(&T) -> &String) -> Vec<T> {
    list.sort_by_key(|item| name(item).to_ascii_lowercase());
    list
}

/// A registry snapshot refreshed at most every [`CACHE_TTL`].
#[derive(Debug, Clone, Default)]
pub struct RegistryCache {
    fetched_at: Option<Instant>,
    registry: ParsedRegistry,
}

impl RegistryCache {
    /// Returns the cached registry, calling `fetch` for a fresh body when the
    /// snapshot is empty or stale. A failed fetch keeps the previous snapshot
    /// and reports the error alongside it.
    pub fn snapshot(
        &mut self,
        fetch: impl FnOnce() -> Result<String, String>,
    ) -> (ParsedRegistry, Option<String>) {
        let fresh = self
            .fetched_at
            .is_some_and(|at| at.elapsed() < CACHE_TTL && !self.registry.is_empty());
        if fresh {
            return (self.registry.clone(), None);
        }
        match fetch().and_then(|body| parse_registry_json(&body)) {
            Ok(parsed) => {
                self.replace(parsed);
                (self.registry.clone(), None)
            }
            Err(error) => (self.registry.clone(), Some(error)),
        }
    }

    /// Installs a parsed registry as the fresh snapshot.
    pub fn replace(&mut self, registry: ParsedRegistry) {
        self.fetched_at = Some(Instant::now());
        self.registry = registry;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_cheers_short_names() {
        assert_eq!(registry_id_for("claude"), "claude-acp");
        assert_eq!(registry_id_for("gemini"), "gemini");
        assert_eq!(cheers_key_for("codex-acp"), "codex");
        assert_eq!(cheers_key_for("cursor"), "cursor");
        assert!(featured_rank("claude") < featured_rank("cursor"));
        assert_eq!(featured_rank("gemini"), FEATURED_AGENTS.len());
    }

    #[test]
    fn cache_keeps_snapshot_when_fetch_fails() {
        let mut cache = RegistryCache::default();
        let body = r#"{"agents":[{"id":"a","name":"A","distribution":{"npx":{"package":"a@1"}}}]}"#;
        let (first, error) = cache.snapshot(|| Ok(body.to_string()));
        assert!(error.is_none());
        assert!(first.packages.contains_key("a"));
        // Fresh: no refetch.
        let (cached, _) = cache.snapshot(|| panic!("fresh cache must not refetch"));
        assert!(cached.packages.contains_key("a"));
        // Stale + failing fetch keeps the old snapshot.
        cache.fetched_at = Some(Instant::now() - CACHE_TTL);
        let (kept, error) = cache.snapshot(|| Err("offline".into()));
        assert_eq!(error.as_deref(), Some("offline"));
        assert!(kept.packages.contains_key("a"));
    }

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
    fn reads_npm_bin_like_npx() {
        let bin = |spec: &str, manifest: &str| parse_npm_bin(spec, manifest).unwrap();
        let cmd = |name: &str| NpmBin::Command(name.into());
        // Single entry, whatever its name.
        assert_eq!(
            bin(
                "@google/gemini-cli@0.52.0",
                r#"{"bin":{"gemini":"bundle/gemini.js"}}"#
            ),
            cmd("gemini")
        );
        // String form: npm names the command after the unscoped package.
        assert_eq!(bin("@scope/tool@1", r#"{"bin":"./cli.js"}"#), cmd("tool"));
        // Several entries: the one named after the package wins.
        assert_eq!(
            bin(
                "@qoder-ai/qodercli@0.2.14",
                r#"{"bin":{"qoder":"bundle/d.cjs","qodercli":"bundle/qodercli.js"}}"#
            ),
            cmd("qodercli")
        );
        // Aliases of one file: the shortest name.
        assert_eq!(
            bin(
                "@kilocode/cli@7.8.18",
                r#"{"bin":{"kilocode":"bin/kilo","kilo":"./bin/kilo"}}"#
            ),
            cmd("kilo")
        );
        assert_eq!(
            bin("x@1", r#"{"bin":{"b":"b.js","a":"a.js"}}"#),
            NpmBin::Ambiguous(vec!["a".into(), "b".into()])
        );
        assert_eq!(bin("x@1", r#"{"name":"x"}"#), NpmBin::Missing);
        assert_eq!(
            bin_name_from_cmd("./dist-package/cursor-agent"),
            "cursor-agent"
        );
    }

    #[test]
    fn builds_npm_manifest_urls() {
        assert_eq!(
            npm_manifest_url("@google/gemini-cli@0.52.0"),
            "https://registry.npmjs.org/@google/gemini-cli/0.52.0"
        );
        assert_eq!(
            npm_manifest_url("cline"),
            "https://registry.npmjs.org/cline/latest"
        );
        assert_eq!(package_version("@scope/pkg"), None);
    }

    #[test]
    fn package_command_falls_back_only_when_npm_is_unreadable() {
        let launch = PackageLaunch {
            id: "gemini".into(),
            name: "Gemini".into(),
            version: "0.52.0".into(),
            package: "@google/gemini-cli@0.52.0".into(),
            args: vec![],
            env_keys: vec![],
            kind: DistKind::Npx,
        };
        let known = NpmBin::Command("gemini".into());
        assert_eq!(
            adapter_command_for(&launch, Some(&known)).as_deref(),
            Some("gemini")
        );
        assert_eq!(
            adapter_command_for(&launch, None).as_deref(),
            Some("gemini-cli")
        );
        let unclear = NpmBin::Ambiguous(vec!["a".into(), "b".into()]);
        assert_eq!(adapter_command_for(&launch, Some(&unclear)), None);
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
}
