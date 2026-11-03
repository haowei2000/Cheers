//! ACP Registry client for the desktop shell (npx + uvx + binary catalog).
//!
//! Parsing and launch recipes come from the shared `cheers-acp-registry` crate
//! (also used by the gateway); this module only fetches and caches.

use std::sync::{LazyLock, Mutex};

pub use cheers_acp_registry::{
    adapter_args_for, adapter_command_for, bin_name_from_cmd, cheers_key_for, featured_rank,
    host_platform, package_name_unversioned, registry_id_for, BinaryLaunch, BinaryTarget, DistKind,
    PackageLaunch,
};
use cheers_acp_registry::{ParsedRegistry, RegistryCache, FETCH_TIMEOUT, REGISTRY_URL};

static CACHE: LazyLock<Mutex<RegistryCache>> =
    LazyLock::new(|| Mutex::new(RegistryCache::default()));

pub fn binary_target_for_host(launch: &BinaryLaunch) -> Option<&BinaryTarget> {
    launch.targets.get(host_platform())
}

fn fetch_registry_body() -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(concat!("cheers-desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(REGISTRY_URL).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("registry HTTP {}", resp.status()));
    }
    resp.text().map_err(|e| e.to_string())
}

fn cache_snapshot() -> ParsedRegistry {
    let mut guard = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    guard.snapshot(fetch_registry_body).0
}

pub fn list_package_agents() -> Vec<PackageLaunch> {
    cache_snapshot().packages_by_name()
}

pub fn list_binary_agents() -> Vec<BinaryLaunch> {
    cache_snapshot().binaries_by_name()
}

pub fn package_launch_by_cheers_key(key: &str) -> Option<PackageLaunch> {
    cache_snapshot().packages.get(registry_id_for(key)).cloned()
}

pub fn binary_launch_by_cheers_key(key: &str) -> Option<BinaryLaunch> {
    cache_snapshot().binaries.get(registry_id_for(key)).cloned()
}
