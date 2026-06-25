//! Correlated gateway→connector request/response for remote-workspace ops.
//!
//! Today `send_data` is fire-and-forget. The remote-workspace browser needs a
//! reply (file tree / file contents), so the gateway registers a one-shot keyed
//! by `req_id`, sends a `workspace_req` data frame, and the data-WS handler
//! resolves the one-shot when the matching `workspace_res` frame arrives.

use dashmap::DashMap;
use serde_json::Value;
use tokio::sync::oneshot;

#[derive(Default)]
pub struct WorkspaceRpc {
    pending: DashMap<String, oneshot::Sender<Value>>,
}

impl WorkspaceRpc {
    pub fn new() -> Self {
        Self {
            pending: DashMap::new(),
        }
    }

    /// Register a pending request; await the returned receiver for the
    /// connector's `workspace_res` frame.
    pub fn register(&self, req_id: String) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        self.pending.insert(req_id, tx);
        rx
    }

    /// Drop a pending request (e.g. send failed / timed out).
    pub fn cancel(&self, req_id: &str) {
        self.pending.remove(req_id);
    }

    /// Resolve a pending request with the connector's `workspace_res` frame.
    pub fn resolve(&self, req_id: &str, frame: Value) {
        if let Some((_, tx)) = self.pending.remove(req_id) {
            let _ = tx.send(frame);
        }
    }
}
