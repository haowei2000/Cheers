//! Polling worker for durable scheduled channel messages.

use crate::{app_state::AppState, domain::scheduled_messages};

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(15));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        tracing::info!("scheduled-message scheduler started");
        loop {
            ticker.tick().await;
            let tasks = match scheduled_messages::claim_due(&state.db).await {
                Ok(tasks) => tasks,
                Err(error) => {
                    tracing::warn!(%error, "scheduled-message claim failed");
                    continue;
                }
            };
            for task in tasks {
                let task_id = task.id.clone();
                if let Err(error) = scheduled_messages::execute_claimed(&state, task).await {
                    tracing::warn!(%task_id, %error, "scheduled message failed");
                }
            }
        }
    });
}
