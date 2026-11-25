//! One local execution attempt per gateway-owned task identity.
//!
//! PostgreSQL owns the durable execution fence. These reservations only ensure
//! duplicate frames in this runtime cannot reuse one granted execution twice.

use super::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct TaskIdentity {
    pub(super) task_id: String,
    pub(super) placeholder_msg_id: String,
    pub(super) channel_id: String,
    pub(super) execution_id: String,
}

impl TaskIdentity {
    pub(super) fn request(&self) -> ControlOutbound {
        ControlOutbound::TaskAccept {
            v: BRIDGE_PROTOCOL_VERSION,
            task_id: self.task_id.clone(),
            placeholder_msg_id: self.placeholder_msg_id.clone(),
            channel_id: self.channel_id.clone(),
            execution_id: self.execution_id.clone(),
        }
    }

    pub(super) fn matches(&self, frame: &ControlInbound) -> bool {
        matches!(frame, ControlInbound::TaskAcceptance {
            v, task_id, placeholder_msg_id, channel_id, execution_id, ..
        } if *v == BRIDGE_PROTOCOL_VERSION && task_id == &self.task_id
            && placeholder_msg_id == &self.placeholder_msg_id
            && channel_id == &self.channel_id
            && execution_id == &self.execution_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(value: Value) -> ControlInbound {
        let mut frame = json!({
            "type":"task", "task_id":"task", "placeholder_msg_id":"placeholder",
            "channel_id":"channel", "trigger_msg_id":"trigger",
            "provider_session_key":"provider", "acceptance_required":true,
        });
        frame
            .as_object_mut()
            .unwrap()
            .extend(value.as_object().unwrap().clone());
        serde_json::from_value(frame).unwrap()
    }

    #[test]
    fn reservations_fence_task_and_placeholder_aliases_and_full_payload_changes() {
        let mut reservations = TaskReservations::default();
        let identity = reservations.reserve(&task(json!({}))).unwrap().unwrap();
        assert!(reservations.reserve(&task(json!({}))).unwrap().is_none());
        assert!(reservations
            .reserve(&task(json!({"enqueued_at":"later"})))
            .unwrap()
            .is_none());
        for changes in [
            json!({"trigger_message":{"text":"changed"}}),
            json!({"binding_config":{"model":"changed"}}),
            json!({"placeholder_msg_id":"another"}),
            json!({"task_id":"another"}),
        ] {
            assert!(reservations.reserve(&task(changes)).is_err());
        }
        // The original reservation still fences all later frames after conflict.
        assert!(reservations.reserve(&task(json!({}))).unwrap().is_none());
        reservations.release(&identity);
        assert!(reservations.by_task.is_empty());
        assert!(reservations.by_placeholder.is_empty());
        let next = reservations.reserve(&task(json!({}))).unwrap().unwrap();
        assert_ne!(identity.execution_id, next.execution_id);
        reservations.release(&identity);
        assert!(
            reservations.reserve(&task(json!({}))).unwrap().is_none(),
            "old cleanup cannot erase a new reservation"
        );
        let restarted = TaskReservations::default()
            .reserve(&task(json!({})))
            .unwrap()
            .unwrap();
        assert_ne!(identity.execution_id, restarted.execution_id);
    }
}

#[derive(Default)]
pub(super) struct TaskReservations {
    by_task: HashMap<String, (TaskIdentity, String)>,
    by_placeholder: HashMap<String, String>,
}

pub(super) struct TaskReservationGuard {
    shared: Arc<SharedRuntimeState>,
    identity: TaskIdentity,
}

impl TaskReservations {
    pub(super) fn is_empty(&self) -> bool {
        self.by_task.is_empty()
    }
}

impl TaskReservationGuard {
    pub(super) fn new(shared: Arc<SharedRuntimeState>, identity: TaskIdentity) -> Self {
        Self { shared, identity }
    }
}

impl Drop for TaskReservationGuard {
    fn drop(&mut self) {
        self.shared
            .task_reservations
            .lock()
            .expect("task reservations poisoned")
            .release(&self.identity);
    }
}

impl TaskReservations {
    /// Reserve before spawning the grant request, until that execution ends.
    pub(super) fn reserve(
        &mut self,
        frame: &ControlInbound,
    ) -> anyhow::Result<Option<TaskIdentity>> {
        let ControlInbound::Task {
            task_id,
            placeholder_msg_id,
            channel_id,
            ..
        } = frame
        else {
            return Err(anyhow!("only standard task frames can reserve execution"));
        };
        if task_id.is_empty() || placeholder_msg_id.is_empty() || channel_id.is_empty() {
            return Err(anyhow!("task execution identity is missing"));
        }
        // Queue timestamps describe delivery, not agent work. Every other
        // normalized field participates, including fields not used by prompts.
        let mut payload = serde_json::to_value(frame)?;
        payload
            .as_object_mut()
            .expect("tagged task object")
            .remove("enqueued_at");
        let fingerprint = etag_of(&serde_json::to_vec(&payload)?);
        if let Some((previous, digest)) = self.by_task.get(task_id) {
            if previous.placeholder_msg_id != *placeholder_msg_id
                || previous.channel_id != *channel_id
                || digest != &fingerprint
            {
                return Err(anyhow!("conflicting duplicate task_id={task_id}"));
            }
            return Ok(None);
        }
        if self.by_placeholder.contains_key(placeholder_msg_id) {
            return Err(anyhow!(
                "placeholder already reserved by another task: {placeholder_msg_id}"
            ));
        }
        let identity = TaskIdentity {
            task_id: task_id.clone(),
            placeholder_msg_id: placeholder_msg_id.clone(),
            channel_id: channel_id.clone(),
            execution_id: Uuid::new_v4().to_string(),
        };
        self.by_placeholder
            .insert(placeholder_msg_id.clone(), task_id.clone());
        self.by_task
            .insert(task_id.clone(), (identity.clone(), fingerprint));
        Ok(Some(identity))
    }

    fn release(&mut self, identity: &TaskIdentity) {
        if self
            .by_task
            .get(&identity.task_id)
            .is_some_and(|(current, _)| current == identity)
        {
            self.by_task.remove(&identity.task_id);
            self.by_placeholder.remove(&identity.placeholder_msg_id);
        }
    }
}
