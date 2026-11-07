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
    npm_manifest_url, parse_npm_bin, NpmBinCache, NpmLookup, ParsedRegistry, RegistryCache,
    FETCH_TIMEOUT, REGISTRY_URL,
};

static CACHE: LazyLock<Mutex<RegistryCache>> =
    LazyLock::new(|| Mutex::new(RegistryCache::default()));

static NPM_BINS: LazyLock<Mutex<NpmBinCache>> =
    LazyLock::new(|| Mutex::new(NpmBinCache::default()));

/// At most this many npm manifest fetches run at once.
const NPM_FETCH_CONCURRENCY: usize = 8;

pub fn binary_target_for_host(launch: &BinaryLaunch) -> Option<&BinaryTarget> {
    launch.targets.get(host_platform())
}

fn fetch_text(url: &str) -> Result<String, String> {
    static CLIENT: LazyLock<Result<reqwest::blocking::Client, String>> = LazyLock::new(|| {
        reqwest::blocking::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .user_agent(concat!("cheers-desktop/", env!("CARGO_PKG_VERSION")))
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

fn npm_cache() -> std::sync::MutexGuard<'static, NpmBinCache> {
    NPM_BINS.lock().unwrap_or_else(|p| p.into_inner())
}

/// Lets the next lookup retry npm manifests that failed (call after an install).
pub fn forget_npm_failures() {
    npm_cache().forget_failures();
}

/// `adapter.command` for each package launch, keyed by package spec; `None`
/// when npm is unreachable or the package's commands are unclear. Uncached npm
/// manifests are fetched a few at a time, without holding the cache lock.
pub fn adapter_commands_for(launches: &[&PackageLaunch]) -> HashMap<String, Option<String>> {
    let unknown: Vec<&str> = {
        let cache = npm_cache();
        launches
            .iter()
            .filter(|l| l.kind == DistKind::Npx && cache.get(&l.package) == NpmLookup::Unknown)
            .map(|l| l.package.as_str())
            .collect()
    };
    for batch in unknown.chunks(NPM_FETCH_CONCURRENCY) {
        let results: Vec<_> = std::thread::scope(|scope| {
            let handles: Vec<_> = batch
                .iter()
                .map(|spec| {
                    scope.spawn(move || {
                        fetch_text(&npm_manifest_url(spec))
                            .and_then(|body| parse_npm_bin(spec, &body))
                    })
                })
                .collect();
            batch
                .iter()
                .zip(handles)
                .map(|(spec, h)| {
                    let result = h
                        .join()
                        .unwrap_or_else(|_| Err("npm fetch panicked".into()));
                    (*spec, result)
                })
                .collect()
        });
        let mut cache = npm_cache();
        for (spec, result) in results {
            cache.record(spec, result);
        }
    }
    let cache = npm_cache();
    launches
        .iter()
        .map(|launch| {
            let npm_bin = match cache.get(&launch.package) {
                NpmLookup::Found(bin) => Some(bin),
                NpmLookup::Failed | NpmLookup::Unknown => None,
            };
            let command = cheers_acp_registry::adapter_command_for(launch, npm_bin.as_ref());
            (launch.package.clone(), command)
        })
        .collect()
}
