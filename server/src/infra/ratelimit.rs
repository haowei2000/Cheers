//! Lightweight in-process fixed-window rate limiter.
//!
//! Login is the one unauthenticated, CPU-heavy (bcrypt) endpoint, so it is the
//! brute-force + algorithmic-DoS target (audit H3). This caps failed attempts
//! per client key. It is per-process (single gateway replica today); a
//! multi-replica deploy should move this to Redis. The login path keys on the
//! nginx-provided `X-Real-IP`, so one source is throttled without locking out a
//! whole account.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use dashmap::DashMap;

struct Window {
    count: u32,
    reset_at: Instant,
}

pub struct FixedWindowLimiter {
    hits: DashMap<String, Window>,
    max: u32,
    window: Duration,
}

impl FixedWindowLimiter {
    fn new(max: u32, window: Duration) -> Self {
        Self {
            hits: DashMap::new(),
            max,
            window,
        }
    }

    /// If `key` is currently over its limit, return the seconds until its window
    /// resets (for a `Retry-After` header); otherwise `None`.
    pub fn retry_after(&self, key: &str) -> Option<u64> {
        let now = Instant::now();
        let e = self.hits.get(key)?;
        if now >= e.reset_at {
            return None;
        }
        if e.count >= self.max {
            Some(e.reset_at.saturating_duration_since(now).as_secs().max(1))
        } else {
            None
        }
    }

    /// Record one failed attempt for `key`, opening or extending its window.
    pub fn record_failure(&self, key: &str) {
        let now = Instant::now();
        // Bound memory under a spoofed-key flood: hard-clear if the map blows up.
        if self.hits.len() > 100_000 {
            self.hits.clear();
        }
        let mut e = self.hits.entry(key.to_string()).or_insert_with(|| Window {
            count: 0,
            reset_at: now + self.window,
        });
        if now >= e.reset_at {
            e.count = 0;
            e.reset_at = now + self.window;
        }
        e.count = e.count.saturating_add(1);
    }

    /// Clear a key's window after a successful attempt.
    pub fn reset(&self, key: &str) {
        self.hits.remove(key);
    }
}

/// Process-global login limiter: at most 10 failed attempts per 5-minute window
/// per client. Tuned so a human fumbling their password is never affected while
/// scripted brute-force is throttled to ~120 guesses/hour per source.
pub fn login_limiter() -> &'static FixedWindowLimiter {
    static LIMITER: OnceLock<FixedWindowLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| FixedWindowLimiter::new(10, Duration::from_secs(300)))
}

/// Process-global enrollment-redeem limiter. `POST /enrollment/redeem` is the
/// other unauthenticated, DB-touching endpoint; the 256-bit code is itself
/// brute-force-infeasible, but this caps wrong/replayed-code attempts per source
/// so a flood can't pin the DB. 20 failures per 5-minute window per client.
pub fn enrollment_redeem_limiter() -> &'static FixedWindowLimiter {
    static LIMITER: OnceLock<FixedWindowLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| FixedWindowLimiter::new(20, Duration::from_secs(300)))
}

/// Best-effort client identity for throttling: prefer the proxy-set `X-Real-IP`
/// (nginx sets it to the real socket address), then the last `X-Forwarded-For`
/// hop, else a fixed bucket. The gateway is only reachable via the in-cluster
/// proxy, so these headers are not client-spoofable in the deployed topology.
pub fn client_key(headers: &axum::http::HeaderMap) -> String {
    if let Some(ip) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        let ip = ip.trim();
        if !ip.is_empty() {
            return ip.to_string();
        }
    }
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(last) = xff.split(',').map(str::trim).filter(|s| !s.is_empty()).last() {
            return last.to_string();
        }
    }
    "unknown".to_string()
}
