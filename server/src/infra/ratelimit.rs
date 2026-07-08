//! Lightweight in-process fixed-window rate limiter.
//!
//! Login is the one unauthenticated, CPU-heavy (bcrypt) endpoint, so it is the
//! brute-force + algorithmic-DoS target (audit H3). This caps failed attempts
//! per client key. It is per-process (single gateway replica today); a
//! multi-replica deploy should move this to Redis. The client key is the peer
//! socket address by default; only with `TRUST_PROXY_HEADERS=true` (gateway
//! reachable exclusively through a trusted proxy) does it use the proxy-set
//! `X-Real-IP` / `X-Forwarded-For` — see [`client_key`].

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

/// Minimum-interval limiter: enforces a floor on how often a given `key` may act,
/// independent of the fixed-window brute-force limiters above. Unlike
/// [`FixedWindowLimiter`] (which counts failures), every *successful* call here
/// records "now" and the next call within `interval` is rejected. Used to keep a
/// bot from spamming status writes (audit item 2). Per-process, best-effort.
pub struct MinIntervalLimiter {
    last: DashMap<String, Instant>,
    interval: Duration,
}

impl MinIntervalLimiter {
    fn new(interval: Duration) -> Self {
        Self {
            last: DashMap::new(),
            interval,
        }
    }

    /// If `key` acted less than `interval` ago, return the seconds until it may
    /// act again (for a `Retry-After` hint). Otherwise record "now" and allow it.
    pub fn check(&self, key: &str) -> Result<(), u64> {
        let now = Instant::now();
        // Bound memory under a spoofed-key flood: hard-clear if the map blows up.
        if self.last.len() > 100_000 {
            self.last.clear();
        }
        // Copy the Instant out and drop the read guard BEFORE `insert` — holding a
        // DashMap ref across a write on the same shard would deadlock.
        let prev = self.last.get(key).map(|r| *r);
        if let Some(prev) = prev {
            let elapsed = now.saturating_duration_since(prev);
            if elapsed < self.interval {
                return Err((self.interval - elapsed).as_secs().max(1));
            }
        }
        self.last.insert(key.to_string(), now);
        Ok(())
    }
}

/// Process-global bot self-status write limiter: at most one write per bot every
/// 5 seconds, keyed by `bot_id`. Guards both write paths (REST `/self-status` and
/// the `bot.status.write` resource verb) so a misbehaving agent can't fan a
/// `member_updated` broadcast storm across every channel it's in (audit item 2).
pub fn bot_status_limiter() -> &'static MinIntervalLimiter {
    static LIMITER: OnceLock<MinIntervalLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| MinIntervalLimiter::new(Duration::from_secs(5)))
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

/// Throttle password-reset requests + code guesses per client (forgot/reset). Caps
/// both email-spam and reset-code brute-force: 10 per 5-minute window per source.
pub fn password_reset_limiter() -> &'static FixedWindowLimiter {
    static LIMITER: OnceLock<FixedWindowLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| FixedWindowLimiter::new(10, Duration::from_secs(300)))
}

/// Throttle public self-service sign-ups per client so open registration can't be
/// script-flooded with junk accounts: 5 per 5-minute window per source.
pub fn register_limiter() -> &'static FixedWindowLimiter {
    static LIMITER: OnceLock<FixedWindowLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| FixedWindowLimiter::new(5, Duration::from_secs(300)))
}

/// Best-effort client identity for throttling.
///
/// `trust_proxy_headers = false` (the default, `TRUST_PROXY_HEADERS` unset):
/// key on the peer socket address ONLY. `X-Real-IP` / `X-Forwarded-For` are
/// plain request headers — whenever the gateway port is directly reachable, an
/// attacker rotates them freely and every rotation gets a fresh brute-force
/// window, so they must not be trusted by default.
///
/// `trust_proxy_headers = true` (gateway reachable exclusively through a proxy
/// that overwrites these headers — the bundled frontend nginx, the compose TLS
/// Caddy edge, or a k8s ingress): prefer `X-Real-IP`, then the LAST
/// `X-Forwarded-For` hop (the entry appended by the trusted proxy; earlier
/// entries are client-supplied), then the peer address.
pub fn client_key(
    headers: &axum::http::HeaderMap,
    peer: Option<std::net::SocketAddr>,
    trust_proxy_headers: bool,
) -> String {
    if trust_proxy_headers {
        if let Some(ip) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
            let ip = ip.trim();
            if !ip.is_empty() {
                return ip.to_string();
            }
        }
        if let Some(last) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|xff| {
                xff.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .last()
            })
        {
            return last.to_string();
        }
    }
    peer.map(|a| a.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    fn peer() -> Option<std::net::SocketAddr> {
        Some("10.1.2.3:55555".parse().unwrap())
    }

    fn spoofing_headers() -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-real-ip", "6.6.6.6".parse().unwrap());
        h.insert("x-forwarded-for", "1.1.1.1, 2.2.2.2".parse().unwrap());
        h
    }

    /// Default (untrusted): spoofable headers are ignored — the key is the peer
    /// socket IP, so rotating X-Real-IP cannot reset a brute-force window.
    #[test]
    fn untrusted_ignores_proxy_headers() {
        assert_eq!(client_key(&spoofing_headers(), peer(), false), "10.1.2.3");
    }

    /// Trusted-proxy mode keeps the historical behavior: X-Real-IP first.
    #[test]
    fn trusted_prefers_x_real_ip() {
        assert_eq!(client_key(&spoofing_headers(), peer(), true), "6.6.6.6");
    }

    /// Trusted-proxy mode without X-Real-IP: the LAST XFF hop (appended by the
    /// trusted proxy) wins, never a client-supplied earlier entry.
    #[test]
    fn trusted_falls_back_to_last_xff_hop() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "1.1.1.1, 2.2.2.2".parse().unwrap());
        assert_eq!(client_key(&h, peer(), true), "2.2.2.2");
    }

    /// No headers, no peer: a fixed shared bucket rather than a panic.
    #[test]
    fn no_signal_yields_fixed_bucket() {
        assert_eq!(client_key(&HeaderMap::new(), None, true), "unknown");
        assert_eq!(client_key(&HeaderMap::new(), None, false), "unknown");
    }
}
