//! Pure Agent Bridge frame classification and acknowledgement-key helpers.

use super::*;

/// Whether the session should stop reconnecting.
///
/// Matches the close code carried by [`BridgeClose`], not the rendered message:
/// classifying on `err.to_string().contains("fatal code=4401")` meant any
/// rewording of that message silently downgraded a revoked credential into an
/// endless reconnect loop.
pub(super) fn is_fatal_bridge_error(err: &anyhow::Error) -> bool {
    err.downcast_ref::<crate::bridge::BridgeClose>()
        .is_some_and(crate::bridge::BridgeClose::is_permanent)
}

pub(super) fn capability_enabled(
    capabilities: &Option<ServerCapabilities>,
    field: impl FnOnce(&ServerCapabilities) -> Option<bool>,
) -> bool {
    capabilities.as_ref().and_then(field).unwrap_or(true)
}

pub(super) fn send_ack_client_msg_id(frame: &DataOutbound) -> Option<&str> {
    match frame {
        DataOutbound::Send { client_msg_id, .. }
        | DataOutbound::PermissionRequest { client_msg_id, .. }
        | DataOutbound::ElicitationRequest { client_msg_id, .. } => Some(client_msg_id),
        _ => None,
    }
}

pub(super) fn terminal_ack_client_msg_id(frame: &DataOutbound) -> Option<&str> {
    match frame {
        DataOutbound::Done { client_msg_id, .. } | DataOutbound::Error { client_msg_id, .. } => {
            Some(client_msg_id)
        }
        _ => None,
    }
}

pub(super) fn file_upload_ack_client_file_id(frame: &DataOutbound) -> Option<&str> {
    match frame {
        DataOutbound::FileUpload { client_file_id, .. } => Some(client_file_id),
        _ => None,
    }
}

pub(super) fn terminal_ack_ok(frame: &DataInbound) -> bool {
    matches!(frame, DataInbound::TerminalAck { ok: true, .. })
}

pub(super) fn terminal_ack_error(frame: &DataInbound) -> Option<String> {
    match frame {
        DataInbound::TerminalAck { error, code, .. } => Some(
            error
                .clone()
                .or_else(|| code.clone())
                .unwrap_or_else(|| "terminal_ack failed".to_string()),
        ),
        _ => None,
    }
}

pub(super) fn send_ack_error(frame: &DataInbound) -> Option<String> {
    match frame {
        DataInbound::SendAck { error, code, .. } => Some(
            error
                .clone()
                .or_else(|| code.clone())
                .unwrap_or_else(|| "send_ack failed".to_string()),
        ),
        _ => None,
    }
}

#[cfg(test)]
mod fatal_close_tests {
    use super::is_fatal_bridge_error;
    use crate::bridge::BridgeClose;
    use cheers_bridge_protocol::{
        WS_CLOSE_AUTH_FAIL, WS_CLOSE_BOT_UNAVAILABLE, WS_CLOSE_SUPERSEDED,
        WS_CLOSE_UNSUPPORTED_PROTOCOL,
    };

    fn closed(code: u16) -> anyhow::Error {
        anyhow::anyhow!(BridgeClose {
            code,
            reason: "test".into(),
        })
    }

    #[test]
    fn stops_only_on_closes_that_can_never_succeed() {
        assert!(is_fatal_bridge_error(&closed(WS_CLOSE_AUTH_FAIL)));
        assert!(is_fatal_bridge_error(&closed(WS_CLOSE_BOT_UNAVAILABLE)));
        // Another connection took over; the next attempt is how this one finds
        // out whether it is still allowed to connect.
        assert!(!is_fatal_bridge_error(&closed(WS_CLOSE_SUPERSEDED)));
        // A self-updating connector recovers once the new binary lands.
        assert!(!is_fatal_bridge_error(&closed(
            WS_CLOSE_UNSUPPORTED_PROTOCOL
        )));
    }

    #[test]
    fn keeps_retrying_on_ordinary_transport_failures() {
        assert!(!is_fatal_bridge_error(&anyhow::anyhow!("connection reset")));
    }

    /// The regression this replaced: classification read the rendered message,
    /// so a reworded error downgraded "revoked" to an endless retry loop. The
    /// code now survives being wrapped in unrelated context.
    #[test]
    fn survives_context_wrapping_and_rewording() {
        use anyhow::Context;
        let wrapped = Err::<(), _>(closed(WS_CLOSE_AUTH_FAIL))
            .context("agent bridge data stream failed")
            .unwrap_err();
        assert!(!wrapped.to_string().contains("fatal code=4401"));
        assert!(is_fatal_bridge_error(&wrapped));
    }
}
