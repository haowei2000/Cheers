//! How this Agent process reaches Cheers MCP (docs/arch/MCP_AUTH_ISOLATION.md
//! §3.4.1, §3.5).
//!
//! Decided once per Agent process, from the local setting, the Gateway's
//! allowed modes (hello), whether the gateway port could bind, and what the
//! Gateway has observed about this Agent build. A mode never changes inside a
//! running Agent: some Agents (Codex) ignore a changed `mcpServers` on
//! `session/load`, so switching means restarting the Agent.

use cheers_bridge_protocol::{McpDeliveryMode, McpDeliveryReport};

use crate::config::McpDelivery;

/// Modes this connector build serves. `acp` arrives with MCP-over-ACP (M6).
pub(crate) const SERVED_MODES: [McpDeliveryMode; 2] =
    [McpDeliveryMode::Direct, McpDeliveryMode::Gateway];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Decision {
    pub mode: McpDeliveryMode,
    pub reason: String,
    /// `direct` for an Agent build the Gateway has not judged yet: renew one
    /// channel's token so the Gateway can see whether the Agent picks it up.
    pub test_direct: bool,
    /// Bind tokens to the running task, so one dies with its task. Only when
    /// every new token reaches the Agent: `gateway` swaps it in per request,
    /// and `direct` only for an Agent judged to re-read headers.
    pub bind_tasks: bool,
}

impl Decision {
    pub(crate) fn report(&self) -> McpDeliveryReport {
        McpDeliveryReport {
            modes: SERVED_MODES.to_vec(),
            mode: self.mode,
            reason: self.reason.clone(),
        }
    }
}

/// Inputs to one decision.
pub(crate) struct Inputs<'a> {
    pub configured: McpDelivery,
    /// Gateway policy from the hello; `None` allows every mode.
    pub allowed: Option<&'a [McpDeliveryMode]>,
    /// The loopback port bound, so `gateway` can be served.
    pub gateway_bound: bool,
    /// `name@version` of the Agent.
    pub agent: &'a str,
    /// The cached verdict for this Agent build, if any.
    pub header_refresh: Option<bool>,
}

pub(crate) fn decide(inputs: Inputs<'_>) -> anyhow::Result<Decision> {
    let allowed = |mode| inputs.allowed.is_none_or(|modes| modes.contains(&mode));
    let direct_ok = allowed(McpDeliveryMode::Direct);
    let gateway_ok = allowed(McpDeliveryMode::Gateway) && inputs.gateway_bound;
    let gateway_why_not = if !allowed(McpDeliveryMode::Gateway) {
        "the Gateway does not allow gateway delivery"
    } else {
        "the gateway's loopback port could not bind"
    };
    let header_refresh = inputs.header_refresh;
    let decision = |mode, reason: String, test_direct| Decision {
        mode,
        reason,
        test_direct,
        bind_tasks: mode == McpDeliveryMode::Gateway
            || (mode == McpDeliveryMode::Direct && header_refresh == Some(true)),
    };
    let agent = inputs.agent;
    Ok(match inputs.configured {
        McpDelivery::Direct if direct_ok => decision(
            McpDeliveryMode::Direct,
            "policy.mcp.delivery = \"direct\"".into(),
            false,
        ),
        McpDelivery::Gateway if gateway_ok => decision(
            McpDeliveryMode::Gateway,
            "policy.mcp.delivery = \"gateway\"".into(),
            false,
        ),
        McpDelivery::Direct if gateway_ok => decision(
            McpDeliveryMode::Gateway,
            "policy.mcp.delivery = \"direct\", but the Gateway does not allow direct delivery"
                .into(),
            false,
        ),
        McpDelivery::Gateway if direct_ok => decision(
            McpDeliveryMode::Direct,
            format!("policy.mcp.delivery = \"gateway\", but {gateway_why_not}"),
            false,
        ),
        McpDelivery::Auto if direct_ok && inputs.header_refresh == Some(true) => decision(
            McpDeliveryMode::Direct,
            format!("{agent} picks up renewed tokens"),
            false,
        ),
        McpDelivery::Auto if direct_ok && inputs.header_refresh.is_none() => decision(
            McpDeliveryMode::Direct,
            format!("{agent} not judged yet; testing direct delivery"),
            true,
        ),
        McpDelivery::Auto if gateway_ok => decision(
            McpDeliveryMode::Gateway,
            if direct_ok {
                format!("{agent} keeps old tokens after a renewal")
            } else {
                "the Gateway does not allow direct delivery".into()
            },
            false,
        ),
        McpDelivery::Auto if direct_ok => decision(
            McpDeliveryMode::Direct,
            format!("{agent} keeps old tokens after a renewal, but {gateway_why_not}; tokens will expire mid-session"),
            false,
        ),
        _ => anyhow::bail!(
            "no MCP delivery mode is possible: the Gateway allows {:?}, this connector serves direct and gateway ({gateway_why_not})",
            inputs.allowed.unwrap_or_default()
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use McpDeliveryMode::{Direct, Gateway};

    fn inputs(configured: McpDelivery) -> Inputs<'static> {
        Inputs {
            configured,
            allowed: None,
            gateway_bound: true,
            agent: "codex-acp@2.3.0",
            header_refresh: None,
        }
    }

    #[test]
    fn auto_prefers_direct_and_tests_unjudged_agents() {
        let unjudged = decide(inputs(McpDelivery::Auto)).unwrap();
        assert_eq!((unjudged.mode, unjudged.test_direct), (Direct, true));
        assert!(
            !unjudged.bind_tasks,
            "an unjudged Agent may keep old tokens"
        );

        let refreshes = decide(Inputs {
            header_refresh: Some(true),
            ..inputs(McpDelivery::Auto)
        })
        .unwrap();
        assert_eq!((refreshes.mode, refreshes.test_direct), (Direct, false));
        assert!(refreshes.bind_tasks);

        let stale = decide(Inputs {
            header_refresh: Some(false),
            ..inputs(McpDelivery::Auto)
        })
        .unwrap();
        assert_eq!(stale.mode, Gateway);
        assert!(stale.bind_tasks, "the gateway swaps in each new token");
        assert!(
            stale.reason.contains("keeps old tokens"),
            "{}",
            stale.reason
        );
    }

    #[test]
    fn gateway_policy_wins_over_the_local_setting() {
        let gateway_only = [Gateway];
        let direct = decide(Inputs {
            allowed: Some(&gateway_only),
            ..inputs(McpDelivery::Direct)
        })
        .unwrap();
        assert_eq!(direct.mode, Gateway);
        let auto = decide(Inputs {
            allowed: Some(&gateway_only),
            header_refresh: Some(true),
            ..inputs(McpDelivery::Auto)
        })
        .unwrap();
        assert_eq!(auto.mode, Gateway);
    }

    #[test]
    fn an_unbound_gateway_is_never_chosen() {
        let unbound = |configured, header_refresh| {
            decide(Inputs {
                gateway_bound: false,
                header_refresh,
                ..inputs(configured)
            })
        };
        assert_eq!(unbound(McpDelivery::Gateway, None).unwrap().mode, Direct);
        let stale = unbound(McpDelivery::Auto, Some(false)).unwrap();
        assert_eq!(stale.mode, Direct);
        assert!(stale.reason.contains("could not bind"), "{}", stale.reason);

        let gateway_only = [Gateway];
        assert!(decide(Inputs {
            allowed: Some(&gateway_only),
            gateway_bound: false,
            ..inputs(McpDelivery::Auto)
        })
        .is_err());
    }

    #[test]
    fn the_report_lists_served_modes() {
        let report = decide(inputs(McpDelivery::Gateway)).unwrap().report();
        assert_eq!(report.modes, [Direct, Gateway]);
        assert_eq!(report.mode, Gateway);
    }
}
