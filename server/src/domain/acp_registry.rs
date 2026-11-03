//! ACP Registry client — dynamic agent catalog for connector config presets.
//!
//! Parsing and launch recipes live in the shared `cheers-acp-registry` crate
//! (also used by the desktop shell); this module only fetches and caches.
//! Network is best-effort: a cache miss or fetch failure falls back to the
//! builtin presets in `agent_catalog`. Tests never hit the network — they seed
//! the cache from fixtures.

use std::sync::{LazyLock, Mutex};

pub use cheers_acp_registry::{
    adapter_args_for, adapter_command_for, bin_name_from_cmd, representative_binary_target,
    BinaryLaunch, PackageLaunch,
};
use cheers_acp_registry::{ParsedRegistry, RegistryCache, FETCH_TIMEOUT, REGISTRY_URL};

static CACHE: LazyLock<Mutex<RegistryCache>> =
    LazyLock::new(|| Mutex::new(RegistryCache::default()));

fn fetch_registry_body() -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(concat!("cheers-gateway/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(REGISTRY_URL).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("registry HTTP {}", resp.status()));
    }
    resp.text().map_err(|e| e.to_string())
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

/// Serialize registry-seeded tests (they share process-wide CACHE).
#[cfg(test)]
pub fn test_registry_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}
