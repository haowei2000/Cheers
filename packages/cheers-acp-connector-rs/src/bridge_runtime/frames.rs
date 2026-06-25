use super::*;

pub(super) fn is_fatal_bridge_error(err: &anyhow::Error) -> bool {
    let text = err.to_string();
    // 4401: auth failure (fatal)
    // 4403: forbidden (fatal)
    // 4402: superseded by new connection (recoverable — reconnect)
    text.contains("fatal code=4401") || text.contains("fatal code=4403")
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
        | DataOutbound::PermissionRequest { client_msg_id, .. } => Some(client_msg_id),
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
