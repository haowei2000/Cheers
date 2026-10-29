//! Observed MCP delivery (docs/arch/MCP_AUTH_ISOLATION.md §3.5).
//!
//! In `direct` delivery the Agent sends the connector-minted bearer itself, so
//! a renewed token only reaches `/mcp` if the Agent re-reads `mcpServers`
//! headers on `session/load`. No ACP or MCP field says whether it does; the
//! token it presents does. JWTs carry `iat`, so a newer token is a newer
//! generation: after the Gateway mints a newer token for a host and channel,
//! an Agent still presenting the older one past [`RENEWAL_GRACE`] kept its
//! old header, and one presenting the newer one re-read it.
//!
//! State is in-process, like the bot registry: one Gateway instance serves
//! every connector, and a reconnect (`ready`) starts a new Agent process whose
//! behaviour is judged afresh.

use std::time::{Duration, Instant};

use cheers_bridge_protocol::{McpDeliveryMode, McpDeliveryReport};
use dashmap::DashMap;
use uuid::Uuid;

/// How long an older token may still arrive after a newer one is minted:
/// requests already in flight, and the `session/load` that hands it over.
pub const RENEWAL_GRACE: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct McpDeliveryTracker {
    hosts: DashMap<Uuid, HostDelivery>,
    generations: DashMap<(Uuid, Uuid), Generation>,
}

struct HostDelivery {
    mode: McpDeliveryMode,
    /// `name@version` of the Agent this connection runs.
    agent: String,
    /// A verdict was already reached for this Agent process.
    decided: bool,
}

struct Generation {
    newest: u64,
    previous: Option<u64>,
    minted: Instant,
}

/// Whether the Agent picked up a renewed token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderRefresh {
    Refreshes,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    pub agent: String,
    pub channel_id: Uuid,
    pub refresh: HeaderRefresh,
}

impl McpDeliveryTracker {
    /// A connector reported `ready`: a new Agent process with its delivery
    /// mode. A connector that predates the report only ever injected headers,
    /// so it is `direct`.
    pub fn record_ready(&self, host_id: Uuid, report: Option<&McpDeliveryReport>, agent: String) {
        self.generations.retain(|(host, _), _| *host != host_id);
        self.hosts.insert(
            host_id,
            HostDelivery {
                mode: report.map_or(McpDeliveryMode::Direct, |report| report.mode),
                agent,
                decided: false,
            },
        );
    }

    /// The Gateway minted a token for `(host, channel)` issued at `iat`.
    pub fn record_mint(&self, host_id: Uuid, channel_id: Uuid, iat: u64, now: Instant) {
        let mut generation = self
            .generations
            .entry((host_id, channel_id))
            .or_insert(Generation {
                newest: iat,
                previous: None,
                minted: now,
            });
        if iat > generation.newest {
            generation.previous = Some(generation.newest);
            generation.newest = iat;
            generation.minted = now;
        }
    }

    /// Judge one authenticated request. Returns a verdict at most once per
    /// Agent process, and only for `direct` delivery.
    pub fn observe(
        &self,
        host_id: Uuid,
        channel_id: Option<Uuid>,
        iat: u64,
        now: Instant,
    ) -> Option<Observation> {
        let channel_id = channel_id?;
        let refresh = {
            let generation = self.generations.get(&(host_id, channel_id))?;
            header_refresh_verdict(
                iat,
                generation.newest,
                generation.previous,
                now.saturating_duration_since(generation.minted),
            )?
        };
        let mut host = self.hosts.get_mut(&host_id)?;
        if host.mode != McpDeliveryMode::Direct || host.decided {
            return None;
        }
        host.decided = true;
        Some(Observation {
            agent: host.agent.clone(),
            channel_id,
            refresh,
        })
    }
}

/// Pure verdict for one presented token against the channel's newest
/// generation. `None` until a renewal has happened and either the newer token
/// arrived or the grace period passed with the older one still in use.
pub fn header_refresh_verdict(
    presented: u64,
    newest: u64,
    previous: Option<u64>,
    since_newest: Duration,
) -> Option<HeaderRefresh> {
    if presented < newest && since_newest >= RENEWAL_GRACE {
        Some(HeaderRefresh::Stale)
    } else if presented == newest && previous.is_some() {
        Some(HeaderRefresh::Refreshes)
    } else {
        None
    }
}

/// `name@version` for the Agent a `ready` frame describes.
pub fn agent_key(name: Option<&str>, version: Option<&str>) -> String {
    format!(
        "{}@{}",
        name.unwrap_or("unknown"),
        version.unwrap_or("unknown")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn direct() -> McpDeliveryReport {
        McpDeliveryReport {
            modes: vec![McpDeliveryMode::Direct, McpDeliveryMode::Gateway],
            mode: McpDeliveryMode::Direct,
            reason: "test".into(),
        }
    }

    #[test]
    fn verdict_needs_a_renewal_and_respects_the_grace_period() {
        let late = RENEWAL_GRACE + Duration::from_secs(1);
        // No renewal yet: nothing to judge.
        assert_eq!(header_refresh_verdict(100, 100, None, late), None);
        // Renewed, Agent sends the newer token.
        assert_eq!(
            header_refresh_verdict(200, 200, Some(100), Duration::ZERO),
            Some(HeaderRefresh::Refreshes)
        );
        // Older token inside the grace period: still in flight.
        assert_eq!(
            header_refresh_verdict(100, 200, Some(100), Duration::from_secs(5)),
            None
        );
        // Older token after the grace period: the Agent kept its header.
        assert_eq!(
            header_refresh_verdict(100, 200, Some(100), late),
            Some(HeaderRefresh::Stale)
        );
    }

    #[test]
    fn stale_agent_is_reported_once_per_agent_process() {
        let tracker = McpDeliveryTracker::default();
        let (host, chan) = (Uuid::new_v4(), Uuid::new_v4());
        let start = Instant::now();
        tracker.record_ready(host, Some(&direct()), "codex-acp@2.3.0".into());
        tracker.record_mint(host, chan, 100, start);
        assert_eq!(tracker.observe(host, Some(chan), 100, start), None);

        tracker.record_mint(host, chan, 200, start);
        let late = start + RENEWAL_GRACE + Duration::from_secs(1);
        let seen = tracker.observe(host, Some(chan), 100, late).unwrap();
        assert_eq!(seen.refresh, HeaderRefresh::Stale);
        assert_eq!(seen.agent, "codex-acp@2.3.0");
        assert_eq!(seen.channel_id, chan);
        assert_eq!(tracker.observe(host, Some(chan), 100, late), None);

        // A reconnect is a new Agent process: judged again from scratch.
        tracker.record_ready(host, Some(&direct()), "codex-acp@2.3.0".into());
        assert_eq!(tracker.observe(host, Some(chan), 100, late), None);
    }

    #[test]
    fn only_direct_delivery_is_judged() {
        let tracker = McpDeliveryTracker::default();
        let (host, chan) = (Uuid::new_v4(), Uuid::new_v4());
        let start = Instant::now();
        let gateway = McpDeliveryReport {
            mode: McpDeliveryMode::Gateway,
            ..direct()
        };
        tracker.record_ready(host, Some(&gateway), "codex-acp@2.3.0".into());
        tracker.record_mint(host, chan, 100, start);
        tracker.record_mint(host, chan, 200, start);
        let late = start + RENEWAL_GRACE + Duration::from_secs(1);
        assert_eq!(tracker.observe(host, Some(chan), 100, late), None);

        // A connector without a report only injects headers: direct.
        tracker.record_ready(host, None, "claude-agent-acp@0.99.0".into());
        tracker.record_mint(host, chan, 300, start);
        tracker.record_mint(host, chan, 400, start);
        assert_eq!(
            tracker
                .observe(host, Some(chan), 400, start)
                .map(|seen| seen.refresh),
            Some(HeaderRefresh::Refreshes)
        );
    }
}
