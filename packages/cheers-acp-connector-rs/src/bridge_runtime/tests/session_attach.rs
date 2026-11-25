//! Resolve a pasted session reference through `session/list`, then attach it
//! with `session/load` — never a fresh `session/new`.

use super::*;
use cheers_bridge_protocol::session_ref::{parse_session_ref, SessionSource};

const THREAD: &str = "01a1422e-d5e6-7e10-be3b-040fa49834a4";

/// A codex-acp-like fixture whose `session/list` serves one session per page,
/// the referenced thread last, with its cwd inside the allowed root. The taps
/// are returned so the bridge writers stay open for session reports.
async fn attach_runtime(
    dir: &std::path::Path,
) -> (
    Arc<RuntimeContext>,
    Arc<Mutex<Vec<String>>>,
    String,
    RuntimeTaps,
) {
    let root = dir.canonicalize().unwrap();
    let project = root.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let allowed = root.clone();
    let (runtime, _started, _release, taps) =
        fixture_runtime_with(dir, PromptGate::First, 4, move |context| {
            context.config.policy.workspace.backend_may_set_cwd = true;
            context.config.policy.workspace.allowed_roots = vec![allowed];
        })
        .await;
    let calls = Arc::new(Mutex::new(Vec::new()));
    let requester = runtime.adapter.lock().await.prompt_client();
    let cwd = project.display().to_string();
    *runtime.adapter.lock().await = Box::new(FakeAdapter {
        prompt_client: requester,
        sessions: AtomicU64::new(0),
        load_sessions: true,
        native_model_only: false,
        auth_enabled: false,
        config_calls: calls.clone(),
        listed_sessions: vec![
            json!({"sessionId": "01a1ec97-2dc3-7390-b043-6a10d88c3c0f", "cwd": "/elsewhere"}),
            json!({"sessionId": THREAD, "cwd": cwd, "title": "hello admin",
                   "updatedAt": "2026-11-18T07:30:49.000Z"}),
        ],
    });
    (runtime, calls, cwd, taps)
}

fn attach_control(cwd: &str, native: &str) -> RuntimeSessionControlSession {
    serde_json::from_value(json!({
        "id": "session-1",
        "provider_session_key": "cheers:session:session-1",
        "primary_scope_type": "channel",
        "primary_scope_id": "channel-1",
        "cwd": cwd,
        "provider_session_id": native,
    }))
    .unwrap()
}

#[tokio::test]
async fn resolve_walks_session_list_pages() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, _calls, cwd, _taps) = attach_runtime(dir.path()).await;
    let reference = parse_session_ref(&format!("codex://threads/{THREAD}"), None).unwrap();

    let found = runtime.resolve_session(&reference).await.unwrap();

    assert_eq!(found["session_id"], THREAD);
    assert_eq!(found["cwd"], cwd);
    assert_eq!(found["title"], "hello admin");
    assert_eq!(found["cwd_allowed"], true);
}

#[tokio::test]
async fn resolve_rejects_other_apps_and_unknown_ids() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, _calls, _cwd, _taps) = attach_runtime(dir.path()).await;

    let claude = parse_session_ref(&format!("claude --resume {THREAD}"), None).unwrap();
    let (code, _) = runtime.resolve_session(&claude).await.unwrap_err();
    assert_eq!(code, "E_SOURCE_MISMATCH");

    let missing =
        parse_session_ref("codex://threads/01a1422e-0000-7000-8000-000000000000", None).unwrap();
    let (code, _) = runtime.resolve_session(&missing).await.unwrap_err();
    assert_eq!(code, "E_NOT_FOUND");
}

#[tokio::test]
async fn attach_loads_the_existing_session_and_binds_it() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, calls, cwd, _taps) = attach_runtime(dir.path()).await;

    let bound = runtime
        .attach_session("req-1", &attach_control(&cwd, THREAD))
        .await
        .unwrap();

    assert_eq!(bound, THREAD);
    assert!(calls.lock().await.contains(&format!("load:{THREAD}")));
    assert_eq!(
        runtime
            .state
            .lock()
            .await
            .get("test", "cheers:session:session-1")
            .as_deref(),
        Some(THREAD)
    );
}

#[tokio::test]
async fn attach_outside_allowed_roots_never_loads_or_binds() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, calls, _cwd, _taps) = attach_runtime(dir.path()).await;
    let outside = tempfile::tempdir().unwrap();

    let error = runtime
        .attach_session(
            "req-1",
            &attach_control(&outside.path().display().to_string(), THREAD),
        )
        .await
        .unwrap_err();

    assert!(error.to_string().contains("cwd rejected"), "{error}");
    assert!(calls
        .lock()
        .await
        .iter()
        .all(|call| !call.starts_with("load:")));
    assert!(runtime
        .state
        .lock()
        .await
        .get("test", "cheers:session:session-1")
        .is_none());
}

#[tokio::test]
async fn attach_source_requires_list_load_and_policy() {
    let dir = tempfile::tempdir().unwrap();
    let mut policy = fixture_config(dir.path(), 4).await.policy;
    let initialize = json!({
        "agentInfo": {"name": "@agentclientprotocol/codex-acp"},
        "agentCapabilities": {"loadSession": true, "sessionCapabilities": {"list": {}}}
    });
    let no_list = json!({
        "agentInfo": {"name": "@agentclientprotocol/codex-acp"},
        "agentCapabilities": {"loadSession": true}
    });

    assert_eq!(
        session_attach_source(&initialize, &policy),
        Some(SessionSource::Codex)
    );
    assert_eq!(session_attach_source(&no_list, &policy), None);
    policy.sessions.load = false;
    assert_eq!(session_attach_source(&initialize, &policy), None);
}

fn chunk(kind: &str, text: &str) -> RuntimeEvent {
    RuntimeEvent::SessionUpdate {
        acp_session_id: THREAD.to_string(),
        update: json!({"sessionUpdate": kind, "content": {"type": "text", "text": text}}),
    }
}

#[tokio::test]
async fn attach_sends_the_replayed_conversation_after_the_load_fence() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, _calls, cwd, mut taps) = attach_runtime(dir.path()).await;
    runtime
        .attach_session("req-1", &attach_control(&cwd, THREAD))
        .await
        .unwrap();
    // `provider session` report from the attach itself.
    while taps.priority.try_recv().is_ok() {}

    for event in [
        chunk("user_message_chunk", "Why does login "),
        chunk("user_message_chunk", "loop?"),
        chunk("agent_thought_chunk", "private reasoning"),
        chunk("agent_message_chunk", "The redirect "),
        chunk("agent_message_chunk", "drops the cookie."),
    ] {
        runtime.clone().handle_adapter_event(event).await.unwrap();
    }
    assert!(
        taps.priority.try_recv().is_err(),
        "nothing is sent before the fence"
    );

    runtime
        .clone()
        .handle_adapter_event(RuntimeEvent::LoadSessionFence {
            acp_session_id: THREAD.to_string(),
        })
        .await
        .unwrap();

    let DataOutbound::SessionHistory {
        session_id,
        channel_id,
        provider_session_id,
        filename,
        markdown,
        ..
    } = taps.priority.try_recv().unwrap()
    else {
        panic!("expected session_history");
    };
    assert_eq!(session_id, "session-1");
    assert_eq!(channel_id, "channel-1");
    assert_eq!(provider_session_id, THREAD);
    assert_eq!(filename, "session-history-01a1422e.md");
    assert!(
        markdown.contains("## User\n\nWhy does login loop?\n"),
        "{markdown}"
    );
    assert!(
        markdown.contains("## Agent\n\nThe redirect drops the cookie.\n"),
        "{markdown}"
    );
    assert!(!markdown.contains("private reasoning"));

    // The capture is gone: a second fence sends nothing more.
    runtime
        .clone()
        .handle_adapter_event(RuntimeEvent::LoadSessionFence {
            acp_session_id: THREAD.to_string(),
        })
        .await
        .unwrap();
    assert!(taps.priority.try_recv().is_err());
}

#[tokio::test]
async fn updates_for_sessions_not_being_attached_are_not_captured() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, _calls, _cwd, mut taps) = attach_runtime(dir.path()).await;
    runtime
        .clone()
        .handle_adapter_event(chunk("agent_message_chunk", "hello"))
        .await
        .unwrap();
    runtime
        .clone()
        .handle_adapter_event(RuntimeEvent::LoadSessionFence {
            acp_session_id: THREAD.to_string(),
        })
        .await
        .unwrap();
    assert!(taps.priority.try_recv().is_err());
}
