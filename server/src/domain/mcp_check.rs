//! The Cheers MCP check for one connector host: three layers of evidence an operator
//! can act on. The gateway layer covers the address agents are given, the host layer
//! covers whether the device can run agent sessions at all, and the agent layer covers
//! what the agent's own MCP client actually did: signed in, reached the endpoint or was
//! rejected, and with which protocol version.
//!
//! Evaluation is pure over recorded evidence (`connector_hosts` columns maintained by
//! `api/mcp.rs`), so the handler stays a loader and every verdict is unit-testable.
//! Copy is operator-facing and never names a raw state value.

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

use super::agent_profile::AgentProfile;

/// What the gateway tells agents, and which MCP revisions it accepts.
pub struct GatewayEvidence<'a> {
    /// `MCP_PUBLIC_URL`, when it is configured.
    pub public_url: Option<&'a str>,
    /// The endpoint agents are actually given (a localhost fallback when unset).
    pub resource_url: &'a str,
    pub protocol_version: &'a str,
    pub legacy_protocol_versions: &'a [&'a str],
}

/// A connector host row plus liveness, as recorded by the gateway.
pub struct HostEvidence {
    pub status: String,
    pub revoked: bool,
    pub online: bool,
    pub connector_version: Option<String>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub agent: AgentProfile,
    pub mcp_state: String,
    pub mcp_token_issued_at: Option<DateTime<Utc>>,
    pub mcp_connected_at: Option<DateTime<Utc>>,
    pub mcp_last_seen_at: Option<DateTime<Utc>>,
    pub mcp_protocol_version: Option<String>,
    pub mcp_client_name: Option<String>,
    pub mcp_client_version: Option<String>,
    pub mcp_rejected_at: Option<DateTime<Utc>>,
    pub mcp_rejection: Option<String>,
}

/// Ordered by severity, so the worst of a set is its maximum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Skip,
    Pass,
    Warn,
    Fail,
}

#[derive(Debug, Serialize)]
pub struct Check {
    pub id: &'static str,
    pub label: &'static str,
    pub status: CheckStatus,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// When the evidence behind this verdict was recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct Layer {
    pub id: &'static str,
    pub title: &'static str,
    pub status: CheckStatus,
    pub checks: Vec<Check>,
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub status: CheckStatus,
    pub checked_at: DateTime<Utc>,
    pub layers: Vec<Layer>,
}

/// How long an agent may take between receiving a token and its first MCP request
/// before a missing request counts as a failure rather than a sign-in in progress.
const SIGN_IN_GRACE_SECONDS: i64 = 60;

pub fn evaluate(gateway: &GatewayEvidence, host: &HostEvidence, now: DateTime<Utc>) -> Report {
    let layers = vec![
        layer("gateway", "Gateway", gateway_checks(gateway)),
        layer("host", "Host", host_checks(host)),
        layer("agent", "Agent", agent_checks(gateway, host, now)),
    ];
    Report {
        status: worst(layers.iter().map(|layer| layer.status)),
        checked_at: now,
        layers,
    }
}

fn layer(id: &'static str, title: &'static str, checks: Vec<Check>) -> Layer {
    Layer {
        id,
        title,
        status: worst(checks.iter().map(|check| check.status)),
        checks,
    }
}

fn worst(statuses: impl Iterator<Item = CheckStatus>) -> CheckStatus {
    statuses.max().unwrap_or(CheckStatus::Skip)
}

impl Check {
    fn new(
        id: &'static str,
        label: &'static str,
        status: CheckStatus,
        summary: impl Into<String>,
    ) -> Self {
        Self {
            id,
            label,
            status,
            summary: summary.into(),
            detail: None,
            hint: None,
            observed_at: None,
        }
    }

    fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    fn observed(mut self, at: Option<DateTime<Utc>>) -> Self {
        self.observed_at = at;
        self
    }
}

fn gateway_checks(gateway: &GatewayEvidence) -> Vec<Check> {
    use CheckStatus::*;
    let endpoint = match gateway.public_url {
        None => Check::new("endpoint", "Endpoint", Fail, "No public MCP address is set")
            .detail(gateway.resource_url)
            .hint("Agents are given a localhost address. Set MCP_PUBLIC_URL to this gateway's HTTPS /mcp address."),
        // Startup validation only allows plain http for loopback development.
        Some(url) if url.starts_with("http://") => Check::new(
            "endpoint",
            "Endpoint",
            Warn,
            "Only agents on the gateway's own machine can reach this address",
        )
        .detail(url)
        .hint("Set MCP_PUBLIC_URL to an HTTPS address when agents run on other devices."),
        Some(url) => {
            Check::new("endpoint", "Endpoint", Pass, "Agents connect to this address").detail(url)
        }
    };
    let protocols = Check::new(
        "protocols",
        "Protocols",
        Pass,
        format!("Accepts MCP {}", gateway.protocol_version),
    )
    .detail(format!(
        "Older agents can use {}",
        gateway.legacy_protocol_versions.join(" or ")
    ));
    vec![endpoint, protocols]
}

fn host_checks(host: &HostEvidence) -> Vec<Check> {
    use CheckStatus::*;
    let registration = if host.revoked {
        Check::new(
            "registration",
            "Registration",
            Fail,
            "This host was revoked",
        )
        .hint("Pair the device again to use it.")
    } else {
        match host.status.as_str() {
            "pending" => Check::new(
                "registration",
                "Registration",
                Fail,
                "Pairing is not finished",
            )
            .hint("Redeem the pairing code on the device."),
            "standby" => Check::new(
                "registration",
                "Registration",
                Warn,
                "This host is on standby",
            )
            .hint("Agent sessions run on the bot's active host. Make this host active to use it."),
            _ => Check::new(
                "registration",
                "Registration",
                Pass,
                "This is the bot's active host",
            ),
        }
    };
    let connector = if host.revoked || host.status != "active" {
        Check::new(
            "connector",
            "Connector",
            Skip,
            "Only the active host connects",
        )
    } else if host.online {
        let check = Check::new("connector", "Connector", Pass, "The connector is online")
            .observed(host.last_seen_at);
        match &host.connector_version {
            Some(version) => check.detail(format!("Connector {version}")),
            None => check,
        }
    } else {
        Check::new("connector", "Connector", Fail, "The connector is offline")
            .hint("Start the Cheers connector on this device, then check again.")
            .observed(host.last_seen_at)
    };
    vec![registration, connector]
}

fn agent_checks(gateway: &GatewayEvidence, host: &HostEvidence, now: DateTime<Utc>) -> Vec<Check> {
    use CheckStatus::*;
    if host.revoked {
        return vec![Check::new(
            "sign_in",
            "Sign-in",
            Skip,
            "Revoked hosts cannot sign in",
        )];
    }
    let agent = host.agent.display_name;
    let update_hint = format!("Update {agent}, then start a new session.");
    // A rejection matters only while nothing has succeeded since it happened.
    let rejection = match (host.mcp_rejected_at, host.mcp_rejection.as_deref()) {
        (Some(at), Some(reason)) if host.mcp_last_seen_at.is_none_or(|seen| at > seen) => {
            Some((at, reason))
        }
        _ => None,
    };

    let sign_in = match host.mcp_state.as_str() {
        "connected" => Check::new("sign_in", "Sign-in", Pass, format!("{agent} signed in to Cheers MCP"))
            .observed(host.mcp_connected_at),
        "action_required" => Check::new("sign_in", "Sign-in", Fail, format!("{agent} needs to sign in"))
            .hint(host.agent.login_hint),
        "refresh_failed" => Check::new("sign_in", "Sign-in", Fail, format!("{agent}'s sign-in expired"))
            .hint(host.agent.login_hint),
        "authorizing" => match rejection {
            Some((at, reason)) => {
                Check::new("sign_in", "Sign-in", Fail, "Cheers rejected the agent's MCP requests")
                    .detail(reason)
                    .hint(update_hint.clone())
                    .observed(Some(at))
            }
            None if host
                .mcp_token_issued_at
                .is_some_and(|issued| now - issued < Duration::seconds(SIGN_IN_GRACE_SECONDS)) =>
            {
                Check::new("sign_in", "Sign-in", Warn, format!("{agent} is signing in"))
                    .hint("Check again in a minute.")
                    .observed(host.mcp_token_issued_at)
            }
            None => Check::new(
                "sign_in",
                "Sign-in",
                Fail,
                format!("{agent} got a Cheers MCP token but never called Cheers MCP"),
            )
            .hint(format!(
                "Make sure {agent} is up to date and supports HTTP MCP servers, then start a new session."
            ))
            .observed(host.mcp_token_issued_at),
        },
        "revoked" => Check::new("sign_in", "Sign-in", Fail, "Cheers MCP access was revoked")
            .hint("Pair the device again to use it."),
        _ => Check::new(
            "sign_in",
            "Sign-in",
            Warn,
            "No agent session has asked for Cheers MCP yet",
        )
        .hint("Send the bot a message to start a session, then check again."),
    };

    let requests = match host.mcp_last_seen_at {
        None => Check::new("requests", "Requests", Skip, "No MCP requests yet"),
        // Reported here only when sign-in succeeded; otherwise sign-in already names it.
        Some(_) if host.mcp_state == "connected" && rejection.is_some() => {
            let (at, reason) = rejection.expect("checked above");
            Check::new(
                "requests",
                "Requests",
                Fail,
                "Cheers rejected the agent's latest MCP request",
            )
            .detail(reason)
            .hint(update_hint)
            .observed(Some(at))
        }
        Some(seen) => {
            let check = Check::new("requests", "Requests", Pass, "Last request from the agent")
                .observed(Some(seen));
            match client_label(host) {
                Some(client) => check.detail(client),
                None => check,
            }
        }
    };

    let protocol = match host.mcp_protocol_version.as_deref() {
        None => Check::new("protocol", "Protocol", Skip, "Known after the agent's first request"),
        Some(version) if version == gateway.protocol_version => {
            Check::new("protocol", "Protocol", Pass, format!("MCP {version}"))
        }
        Some(version) => Check::new("protocol", "Protocol", Warn, format!("Older MCP version {version}"))
            .hint(format!(
                "This works through a temporary compatibility window. Update {agent} once it supports MCP {}.",
                gateway.protocol_version
            )),
    };

    vec![sign_in, requests, protocol]
}

fn client_label(host: &HostEvidence) -> Option<String> {
    match (&host.mcp_client_name, &host.mcp_client_version) {
        (Some(name), Some(version)) => Some(format!("{name} {version}")),
        (Some(name), None) => Some(name.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agent_profile::profile;

    const LEGACY: [&str; 2] = ["2025-11-25", "2025-06-18"];

    fn gateway(public_url: Option<&str>) -> GatewayEvidence<'_> {
        GatewayEvidence {
            public_url,
            resource_url: public_url.unwrap_or("http://localhost:8000/mcp"),
            protocol_version: "2026-07-28",
            legacy_protocol_versions: &LEGACY,
        }
    }

    fn now() -> DateTime<Utc> {
        "2026-09-15T12:00:00Z".parse().unwrap()
    }

    fn minutes_ago(minutes: i64) -> Option<DateTime<Utc>> {
        Some(now() - Duration::minutes(minutes))
    }

    /// An online active Codex host whose agent reached Cheers over MCP 2025-06-18.
    fn codex_host() -> HostEvidence {
        HostEvidence {
            status: "active".into(),
            revoked: false,
            online: true,
            connector_version: Some("0.1.41".into()),
            last_seen_at: minutes_ago(1),
            agent: profile("codex"),
            mcp_state: "connected".into(),
            mcp_token_issued_at: minutes_ago(6),
            mcp_connected_at: minutes_ago(6),
            mcp_last_seen_at: minutes_ago(2),
            mcp_protocol_version: Some("2025-06-18".into()),
            mcp_client_name: Some("codex-mcp-client".into()),
            mcp_client_version: Some("0.145.0".into()),
            mcp_rejected_at: None,
            mcp_rejection: None,
        }
    }

    fn check<'r>(report: &'r Report, layer: &str, id: &str) -> &'r Check {
        report
            .layers
            .iter()
            .find(|l| l.id == layer)
            .and_then(|l| l.checks.iter().find(|c| c.id == id))
            .unwrap_or_else(|| panic!("missing check {layer}/{id}"))
    }

    #[test]
    fn a_working_legacy_agent_passes_with_a_protocol_warning() {
        let report = evaluate(
            &gateway(Some("https://cheers.example/mcp")),
            &codex_host(),
            now(),
        );
        assert_eq!(
            check(&report, "gateway", "endpoint").status,
            CheckStatus::Pass
        );
        assert_eq!(
            check(&report, "host", "connector").status,
            CheckStatus::Pass
        );
        assert_eq!(check(&report, "agent", "sign_in").status, CheckStatus::Pass);
        let requests = check(&report, "agent", "requests");
        assert_eq!(requests.status, CheckStatus::Pass);
        assert_eq!(requests.detail.as_deref(), Some("codex-mcp-client 0.145.0"));
        assert_eq!(
            check(&report, "agent", "protocol").status,
            CheckStatus::Warn
        );
        assert_eq!(report.status, CheckStatus::Warn);
    }

    #[test]
    fn gateway_address_is_graded_by_who_can_reach_it() {
        let host = codex_host();
        let unset = evaluate(&gateway(None), &host, now());
        assert_eq!(
            check(&unset, "gateway", "endpoint").status,
            CheckStatus::Fail
        );
        let loopback = evaluate(&gateway(Some("http://localhost:30080/mcp")), &host, now());
        assert_eq!(
            check(&loopback, "gateway", "endpoint").status,
            CheckStatus::Warn
        );
    }

    #[test]
    fn a_rejected_first_request_names_the_reason() {
        let host = HostEvidence {
            mcp_state: "authorizing".into(),
            mcp_connected_at: None,
            mcp_last_seen_at: None,
            mcp_protocol_version: None,
            mcp_client_name: None,
            mcp_client_version: None,
            mcp_token_issued_at: minutes_ago(5),
            mcp_rejected_at: minutes_ago(5),
            mcp_rejection: Some("MCP-Protocol-Version header is required (-32020)".into()),
            ..codex_host()
        };
        let report = evaluate(&gateway(Some("https://cheers.example/mcp")), &host, now());
        let sign_in = check(&report, "agent", "sign_in");
        assert_eq!(sign_in.status, CheckStatus::Fail);
        assert_eq!(
            sign_in.detail.as_deref(),
            Some("MCP-Protocol-Version header is required (-32020)")
        );
        assert_eq!(
            check(&report, "agent", "requests").status,
            CheckStatus::Skip
        );
        assert_eq!(
            check(&report, "agent", "protocol").status,
            CheckStatus::Skip
        );
        assert_eq!(report.status, CheckStatus::Fail);
    }

    #[test]
    fn a_token_without_any_request_fails_only_after_the_grace_period() {
        let silent = HostEvidence {
            mcp_state: "authorizing".into(),
            mcp_connected_at: None,
            mcp_last_seen_at: None,
            mcp_token_issued_at: minutes_ago(5),
            ..codex_host()
        };
        let report = evaluate(&gateway(Some("https://cheers.example/mcp")), &silent, now());
        assert_eq!(check(&report, "agent", "sign_in").status, CheckStatus::Fail);

        let starting = HostEvidence {
            mcp_token_issued_at: Some(now() - Duration::seconds(20)),
            ..silent
        };
        let report = evaluate(
            &gateway(Some("https://cheers.example/mcp")),
            &starting,
            now(),
        );
        assert_eq!(check(&report, "agent", "sign_in").status, CheckStatus::Warn);
    }

    #[test]
    fn a_rejection_after_the_last_success_fails_requests_but_an_older_one_does_not() {
        let newer = HostEvidence {
            mcp_rejected_at: minutes_ago(1),
            mcp_rejection: Some("Insufficient OAuth scope cheers:messages:write (-32003)".into()),
            ..codex_host()
        };
        let report = evaluate(&gateway(Some("https://cheers.example/mcp")), &newer, now());
        assert_eq!(check(&report, "agent", "sign_in").status, CheckStatus::Pass);
        assert_eq!(
            check(&report, "agent", "requests").status,
            CheckStatus::Fail
        );

        let resolved = HostEvidence {
            mcp_rejected_at: minutes_ago(30),
            ..newer
        };
        let report = evaluate(
            &gateway(Some("https://cheers.example/mcp")),
            &resolved,
            now(),
        );
        assert_eq!(
            check(&report, "agent", "requests").status,
            CheckStatus::Pass
        );
    }

    #[test]
    fn standby_offline_and_revoked_hosts_are_explained() {
        let standby = HostEvidence {
            status: "standby".into(),
            online: false,
            ..codex_host()
        };
        let report = evaluate(
            &gateway(Some("https://cheers.example/mcp")),
            &standby,
            now(),
        );
        assert_eq!(
            check(&report, "host", "registration").status,
            CheckStatus::Warn
        );
        assert_eq!(
            check(&report, "host", "connector").status,
            CheckStatus::Skip
        );

        let offline = HostEvidence {
            online: false,
            ..codex_host()
        };
        let report = evaluate(
            &gateway(Some("https://cheers.example/mcp")),
            &offline,
            now(),
        );
        assert_eq!(
            check(&report, "host", "connector").status,
            CheckStatus::Fail
        );

        let revoked = HostEvidence {
            revoked: true,
            mcp_state: "revoked".into(),
            ..codex_host()
        };
        let report = evaluate(
            &gateway(Some("https://cheers.example/mcp")),
            &revoked,
            now(),
        );
        assert_eq!(
            check(&report, "host", "registration").status,
            CheckStatus::Fail
        );
        let agent = report.layers.iter().find(|l| l.id == "agent").unwrap();
        assert_eq!(agent.status, CheckStatus::Skip);
    }

    #[test]
    fn a_modern_agent_passes_every_layer() {
        let modern = HostEvidence {
            mcp_protocol_version: Some("2026-07-28".into()),
            ..codex_host()
        };
        let report = evaluate(&gateway(Some("https://cheers.example/mcp")), &modern, now());
        assert_eq!(report.status, CheckStatus::Pass);
    }
}
