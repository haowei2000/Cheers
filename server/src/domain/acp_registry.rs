//! ACP Registry client — dynamic agent catalog for connector config presets.
//!
//! Parsing and launch recipes live in the shared `cheers-acp-registry` crate
//! (also used by the desktop shell); this module only fetches and caches.
//! Network is best-effort: a cache miss or fetch failure falls back to the
//! builtin presets in `agent_catalog`, and an unreachable npm registry leaves
//! the command unknown (the config is flagged for editing). Tests never hit
//! the network — they seed both caches from fixtures.

use std::sync::{LazyLock, Mutex};

pub use cheers_acp_registry::{
    adapter_args_for, bin_name_from_cmd, representative_binary_target, BinaryLaunch, PackageLaunch,
};
use cheers_acp_registry::{
    npm_manifest_url, parse_npm_bin, DistKind, NpmBin, NpmBinCache, NpmLookup, ParsedRegistry,
    RegistryCache, REGISTRY_URL,
};

static CACHE: LazyLock<Mutex<RegistryCache>> =
    LazyLock::new(|| Mutex::new(RegistryCache::default()));

static NPM_BINS: LazyLock<Mutex<NpmBinCache>> =
    LazyLock::new(|| Mutex::new(NpmBinCache::default()));

#[cfg(not(test))]
fn fetch_text(url: &str) -> Result<String, String> {
    static CLIENT: LazyLock<Result<reqwest::blocking::Client, String>> = LazyLock::new(|| {
        reqwest::blocking::Client::builder()
            .timeout(cheers_acp_registry::FETCH_TIMEOUT)
            .user_agent(concat!("cheers-gateway/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())
    });
    let client = CLIENT.as_ref().map_err(Clone::clone)?;
    let resp = client.get(url).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} for {url}", resp.status()));
    }
    resp.text().map_err(|e| e.to_string())
}

/// Tests never hit the network; they seed the caches instead.
#[cfg(test)]
fn fetch_text(url: &str) -> Result<String, String> {
    Err(format!("network disabled in tests ({url})"))
}

fn fetch_registry_body() -> Result<String, String> {
    fetch_text(REGISTRY_URL)
}

fn npm_cache() -> std::sync::MutexGuard<'static, NpmBinCache> {
    NPM_BINS.lock().unwrap_or_else(|p| p.into_inner())
}

/// What the npm manifest says `spec` installs, or `None` when npm is unreachable.
/// The fetch runs without the cache lock, so cached lookups never wait on it.
fn npm_bin_for(spec: &str) -> Option<NpmBin> {
    match npm_cache().get(spec) {
        NpmLookup::Found(bin) => return Some(bin),
        NpmLookup::Failed => return None,
        NpmLookup::Unknown => {}
    }
    let result = fetch_text(&npm_manifest_url(spec)).and_then(|body| parse_npm_bin(spec, &body));
    if let Err(e) = &result {
        tracing::warn!(error = %e, package = %spec, "npm bin lookup failed; adapter.command needs editing");
    }
    npm_cache().record(spec, result)
}

/// `adapter.command` for a package launch, or `None` when the package's npm
/// manifest does not say which of its commands to run.
pub fn adapter_command_for(launch: &PackageLaunch) -> Option<String> {
    let npm_bin = match launch.kind {
        DistKind::Npx => npm_bin_for(&launch.package),
        DistKind::Uvx => None,
    };
    cheers_acp_registry::adapter_command_for(launch, npm_bin.as_ref())
}

fn cache_snapshot() -> ParsedRegistry {
    let mut guard = CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (registry, error) = guard.snapshot(fetch_registry_body);
    if let Some(e) = error {
        tracing::warn!(error = %e, "ACP registry fetch failed; using cached/empty");
    }
    registry
}

/// Look up a package launch by Cheers agent id or legacy short name.
pub fn package_launch_for(agent_type: &str) -> Option<PackageLaunch> {
    let id = crate::domain::agent_catalog::registry_id(agent_type);
    cache_snapshot().packages.get(&id).cloned()
}

/// Look up a binary launch by Cheers agent id.
pub fn binary_launch_for(agent_type: &str) -> Option<BinaryLaunch> {
    let id = crate::domain::agent_catalog::registry_id(agent_type);
    cache_snapshot().binaries.get(&id).cloned()
}

/// All cached npx/uvx agents (triggers a fetch on cold cache). Sorted by name.
pub fn list_package_agents() -> Vec<PackageLaunch> {
    cache_snapshot().packages_by_name()
}

/// All cached binary-only agents. Sorted by name.
pub fn list_binary_agents() -> Vec<BinaryLaunch> {
    cache_snapshot().binaries_by_name()
}

/// Seed the cache from JSON (tests / offline inject). Replaces any prior entry.
/// Tests that call this must hold [`test_registry_lock`] so parallel cases don't
/// clobber each other's fixtures.
#[cfg(test)]
pub fn seed_cache_for_test(raw: &str) {
    let parsed = cheers_acp_registry::parse_registry_json(raw).expect("fixture");
    CACHE.lock().unwrap().replace(parsed);
}

/// Seed the npm `bin` answer for one package spec from a manifest fixture.
#[cfg(test)]
pub fn seed_npm_manifest_for_test(spec: &str, manifest: &str) {
    npm_cache().record(spec, parse_npm_bin(spec, manifest));
}

/// Serialize registry-seeded tests (they share process-wide CACHE).
#[cfg(test)]
pub fn test_registry_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}
