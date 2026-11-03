//! ACP Registry client for the desktop shell (npx + uvx + binary catalog).
//!
//! Parsing and launch recipes come from the shared `cheers-acp-registry` crate
//! (also used by the gateway); this module only fetches and caches.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

pub use cheers_acp_registry::{
    adapter_args_for, bin_name_from_cmd, cheers_key_for, featured_rank, host_platform,
    package_name_unversioned, registry_id_for, BinaryLaunch, BinaryTarget, DistKind, PackageLaunch,
};
use cheers_acp_registry::{
    npm_manifest_url, parse_npm_bin, unscoped_package_name, NpmBin, ParsedRegistry, RegistryCache,
    FETCH_TIMEOUT, REGISTRY_URL,
};

static CACHE: LazyLock<Mutex<RegistryCache>> =
    LazyLock::new(|| Mutex::new(RegistryCache::default()));

/// npm `bin` answers by exact package spec; failed fetches are not cached.
static NPM_BINS: LazyLock<Mutex<HashMap<String, NpmBin>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn binary_target_for_host(launch: &BinaryLaunch) -> Option<&BinaryTarget> {
    launch.targets.get(host_platform())
}

fn fetch_text(url: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(concat!("cheers-desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} for {url}", resp.status()));
    }
    resp.text().map_err(|e| e.to_string())
}

fn fetch_registry_body() -> Result<String, String> {
    fetch_text(REGISTRY_URL)
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

/// `adapter.command` for each package launch, keyed by package spec. npm
/// manifests are fetched concurrently and cached; when npm is unreachable or a
/// package's commands are unclear, the unscoped package name stands in.
pub fn adapter_commands_for(launches: &[PackageLaunch]) -> HashMap<String, String> {
    let missing: Vec<&str> = {
        let cache = NPM_BINS.lock().unwrap_or_else(|p| p.into_inner());
        launches
            .iter()
            .filter(|l| l.kind == DistKind::Npx && !cache.contains_key(&l.package))
            .map(|l| l.package.as_str())
            .collect()
    };
    let fetched: Vec<(String, NpmBin)> = std::thread::scope(|scope| {
        let handles: Vec<_> = missing
            .iter()
            .map(|spec| {
                scope.spawn(move || {
                    fetch_text(&npm_manifest_url(spec))
                        .and_then(|body| parse_npm_bin(spec, &body))
                        .ok()
                        .map(|bin| (spec.to_string(), bin))
                })
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|h| h.join().ok().flatten())
            .collect()
    });
    let mut cache = NPM_BINS.lock().unwrap_or_else(|p| p.into_inner());
    cache.extend(fetched);
    launches
        .iter()
        .map(|launch| {
            let command =
                cheers_acp_registry::adapter_command_for(launch, cache.get(&launch.package))
                    .unwrap_or_else(|| unscoped_package_name(&launch.package));
            (launch.package.clone(), command)
        })
        .collect()
}
