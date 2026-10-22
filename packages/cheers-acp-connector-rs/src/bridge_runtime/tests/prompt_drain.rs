//! Real stdio RPC responses must not overtake updates awaiting runtime handling.

use super::*;

const FAST_AGENT: &str = r#"
import json, re, sys, uuid
pending = {}
def emit(value):
    print(json.dumps(value), flush=True)
def reply(request, result):
    emit({'jsonrpc': '2.0', 'id': request['id'], 'result': result})
for line in sys.stdin:
    request = json.loads(line)
    method, params = request.get('method'), request.get('params', {})
    if method == 'session/cancel':
        original = pending.pop(params['sessionId'])
        reply(original, {'stopReason': 'cancelled'})
        continue
    if 'id' not in request:
        continue
    if method == 'initialize':
        reply(request, {'protocolVersion': params['protocolVersion'],
            'agentCapabilities': {'loadSession': True}, 'authMethods': []})
    elif method == 'session/new':
        reply(request, {'sessionId': str(uuid.uuid4())})
    elif method == 'session/load':
        reply(request, {})
    elif method == 'session/prompt':
        text = '\n'.join(part.get('text', '') for part in params['prompt'])
        case = re.search(r'case=([a-z]+)', text).group(1)
        if case != 'empty':
            emit({'jsonrpc': '2.0', 'method': 'session/update', 'params': {
                'sessionId': params['sessionId'], 'update': {
                    'sessionUpdate': 'agent_message_chunk',
                    'content': {'type': 'text', 'text': 'RESULT:' + case}}}})
        if case == 'cancel':
            pending[params['sessionId']] = request
        elif case == 'error':
            emit({'jsonrpc': '2.0', 'id': request['id'], 'error': {
                'code': -32000, 'message': 'deterministic prompt failure'}})
        else:
            # Deliberately no pause between the notification and the RPC response.
            reply(request, {'stopReason': 'end_turn'})
"#;

async fn transport_runtime(
    dir: &Path,
    legacy: bool,
) -> (
    Arc<RuntimeContext>,
    mpsc::Receiver<RuntimeEvent>,
    RuntimeTaps,
) {
    let (mut runtime, _, _, taps) = fixture_runtime(dir, PromptGate::All, 4).await;
    let script = dir.join("fast_agent.py");
    tokio::fs::write(&script, FAST_AGENT).await.unwrap();
    let mut config = runtime.config.agent.clone();
    config.command = "python3".into();
    config.args = vec!["-u".into(), script.display().to_string()];
    let (events, receiver) = mpsc::channel(64);
    let mut adapter: Box<dyn RuntimeAdapter> = if legacy {
        Box::new(crate::acp_adapter::AcpAdapter::new("test", config, events))
    } else {
        Box::new(crate::acp_runtime::RuntimeAcpAdapter::new(
            "test", config, events,
        ))
    };
    timeout(Duration::from_secs(10), adapter.start())
        .await
        .expect("initialize real stdio fixture")
        .unwrap();
    Arc::get_mut(&mut runtime).unwrap().adapter = Arc::new(Mutex::new(adapter));
    (runtime, receiver, taps)
}

fn task_case(channel: &str, case: &str) -> TaskCommand {
    let mut task = fixture_task(channel);
    task.trigger_message.as_mut().unwrap()["text"] = json!(format!("case={case}"));
    task
}

async fn next_event(events: &mut mpsc::Receiver<RuntimeEvent>) -> RuntimeEvent {
    timeout(Duration::from_secs(10), events.recv())
        .await
        .expect("real transport must produce the next event")
        .expect("adapter event channel stays open")
}

async fn stop(runtime: &RuntimeContext) {
    timeout(Duration::from_secs(10), async {
        runtime.adapter.lock().await.stop().await
    })
    .await
    .unwrap()
    .unwrap();
}

fn assert_no_terminal(taps: &mut RuntimeTaps) {
    assert!(taps.drain_priority().iter().all(|frame| !matches!(
        frame,
        DataOutbound::Done { .. } | DataOutbound::Error { .. }
    )));
}

fn assert_run_removed(runtime: &RuntimeContext) {
    let runs = runtime.shared.runs.try_lock().unwrap();
    assert!(runs.by_msg.is_empty());
    assert!(runs.by_acp_session.is_empty());
    assert!(runs.by_provider_key.is_empty());
    assert!(runs.cwd_by_msg.is_empty());
}

#[tokio::test]
async fn fast_stdio_result_waits_for_the_runtime_to_apply_its_chunk() {
    for legacy in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (runtime, mut events, mut taps) = transport_runtime(dir.path(), legacy).await;
        let turn = tokio::spawn(runtime.clone().run_task(task_case("fast", "fast"), None));
        let mut updates = Vec::new();
        let barrier = loop {
            let event = next_event(&mut events).await;
            match event {
                RuntimeEvent::LoadSessionFence { .. } => {
                    runtime.clone().handle_adapter_event(event).await.unwrap();
                }
                RuntimeEvent::SessionUpdate { .. } => updates.push(event),
                RuntimeEvent::UpdatesDrained { .. } => break event,
                other => panic!("unexpected event: {other:?}"),
            }
        };
        // UpdatesDrained can be sent only after the real session/prompt RPC
        // response has reached its caller. Its earlier chunk is still unapplied.
        assert_eq!(updates.len(), 1);
        assert!(!turn.is_finished());
        assert_no_terminal(&mut taps);
        assert!(runtime.shared.runs.lock().await.by_msg["msg-fast"]
            .lock()
            .await
            .text
            .is_empty());
        for update in updates {
            runtime.clone().handle_adapter_event(update).await.unwrap();
        }
        // Applying the text alone does not release the response waiter.
        assert!(!turn.is_finished());
        runtime.clone().handle_adapter_event(barrier).await.unwrap();
        timeout(Duration::from_secs(10), turn)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let frames = taps.drain_priority();
        assert_eq!(
            frames
                .iter()
                .filter(|frame| matches!(frame,
                DataOutbound::Done { content: Some(text), .. } if text == "RESULT:fast"))
                .count(),
            1,
            "legacy={legacy}: {frames:?}"
        );
        assert_run_removed(&runtime);
        stop(&runtime).await;
    }
}

#[tokio::test]
async fn empty_error_and_cancelled_stdio_turns_also_wait_for_update_ack() {
    for legacy in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (runtime, mut events, mut taps) = transport_runtime(dir.path(), legacy).await;
        for case in ["empty", "error", "cancel"] {
            let turn = tokio::spawn(runtime.clone().run_task(task_case("same", case), None));
            let mut updates = Vec::new();
            let barrier = loop {
                let event = next_event(&mut events).await;
                match event {
                    RuntimeEvent::LoadSessionFence { .. } => {
                        runtime.clone().handle_adapter_event(event).await.unwrap();
                    }
                    RuntimeEvent::SessionUpdate {
                        ref acp_session_id, ..
                    } => {
                        if case == "cancel" {
                            // The prompt is still waiting for the agent. Cancelling
                            // must remain possible without its lifecycle lock held.
                            timeout(Duration::from_secs(10), async {
                                runtime.adapter.lock().await.cancel(acp_session_id).await
                            })
                            .await
                            .unwrap()
                            .unwrap();
                        }
                        updates.push(event);
                    }
                    RuntimeEvent::UpdatesDrained { .. } => break event,
                    other => panic!("unexpected event: {other:?}"),
                }
            };
            assert_eq!(updates.len(), usize::from(case != "empty"));
            assert!(!turn.is_finished());
            assert_no_terminal(&mut taps);
            for update in updates {
                runtime.clone().handle_adapter_event(update).await.unwrap();
            }
            runtime.clone().handle_adapter_event(barrier).await.unwrap();
            timeout(Duration::from_secs(10), turn)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let terminals: Vec<_> = taps
                .drain_priority()
                .into_iter()
                .filter(|frame| {
                    matches!(
                        frame,
                        DataOutbound::Done { .. } | DataOutbound::Error { .. }
                    )
                })
                .collect();
            assert_eq!(terminals.len(), 1, "legacy={legacy}, case={case}");
            match &terminals[0] {
                DataOutbound::Error { message, .. } if case == "error" => {
                    assert!(message.contains("deterministic prompt failure"));
                }
                DataOutbound::Done { content, .. } if case != "error" => {
                    assert_eq!(
                        content.as_deref(),
                        Some(if case == "empty" { "" } else { "RESULT:cancel" })
                    );
                }
                other => panic!("legacy={legacy}, case={case}: {other:?}"),
            }
            assert_run_removed(&runtime);
        }
        stop(&runtime).await;
    }
}

#[tokio::test]
async fn concurrent_stdio_sessions_have_independent_drain_waiters() {
    for legacy in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (runtime, mut events, mut taps) = transport_runtime(dir.path(), legacy).await;
        let alpha = tokio::spawn(runtime.clone().run_task(task_case("alpha", "alpha"), None));
        let beta = tokio::spawn(runtime.clone().run_task(task_case("beta", "beta"), None));
        let mut updates = Vec::new();
        let mut barriers = Vec::new();
        while barriers.len() < 2 {
            let event = next_event(&mut events).await;
            match event {
                RuntimeEvent::LoadSessionFence { .. } => {
                    runtime.clone().handle_adapter_event(event).await.unwrap();
                }
                RuntimeEvent::SessionUpdate { .. } => updates.push(event),
                RuntimeEvent::UpdatesDrained { .. } => barriers.push(event),
                other => panic!("unexpected event: {other:?}"),
            }
        }
        assert_eq!(updates.len(), 2);
        assert!(!alpha.is_finished() && !beta.is_finished());
        assert_no_terminal(&mut taps);
        // Holding both completion waiters must not retain the adapter mutex.
        let adapter = timeout(Duration::from_secs(10), runtime.adapter.lock())
            .await
            .unwrap();
        drop(adapter);
        for update in updates {
            runtime.clone().handle_adapter_event(update).await.unwrap();
        }
        runtime
            .clone()
            .handle_adapter_event(barriers.pop().unwrap())
            .await
            .unwrap();
        let first = timeout(Duration::from_secs(10), async {
            loop {
                let frame = taps.priority.recv().await.unwrap();
                if matches!(frame, DataOutbound::Done { .. }) {
                    break frame;
                }
            }
        })
        .await
        .unwrap();
        let first_message = match first {
            DataOutbound::Done {
                msg_id, content, ..
            } => {
                assert_eq!(
                    content.as_deref(),
                    Some(if msg_id == "msg-alpha" {
                        "RESULT:alpha"
                    } else {
                        "RESULT:beta"
                    })
                );
                msg_id
            }
            _ => unreachable!(),
        };
        assert_no_terminal(&mut taps);
        runtime
            .clone()
            .handle_adapter_event(barriers.pop().unwrap())
            .await
            .unwrap();
        timeout(Duration::from_secs(10), async {
            alpha.await.unwrap().unwrap();
            beta.await.unwrap().unwrap();
        })
        .await
        .unwrap();
        let frames = taps.drain_priority();
        assert_eq!(frames.iter().filter(|frame| matches!(frame,
            DataOutbound::Done { msg_id, content: Some(text), .. }
                if msg_id != &first_message && text == if msg_id == "msg-alpha" { "RESULT:alpha" } else { "RESULT:beta" })).count(), 1);
        assert_run_removed(&runtime);
        stop(&runtime).await;
    }
}

#[tokio::test]
async fn closing_the_stdio_update_consumer_fails_instead_of_hanging_or_committing_empty_done() {
    for legacy in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (runtime, mut events, mut taps) = transport_runtime(dir.path(), legacy).await;
        let turn = tokio::spawn(
            runtime
                .clone()
                .run_task(task_case("closed", "closed"), None),
        );
        loop {
            let event = next_event(&mut events).await;
            match event {
                RuntimeEvent::LoadSessionFence { .. } => {
                    runtime.clone().handle_adapter_event(event).await.unwrap();
                }
                RuntimeEvent::SessionUpdate { .. } => {}
                RuntimeEvent::UpdatesDrained { .. } => {
                    drop(event);
                    break;
                }
                other => panic!("unexpected event: {other:?}"),
            }
        }
        drop(events);
        timeout(Duration::from_secs(10), turn)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let frames = taps.drain_priority();
        assert!(frames
            .iter()
            .all(|frame| !matches!(frame, DataOutbound::Done { .. })));
        assert_eq!(
            frames
                .iter()
                .filter(|frame| matches!(frame,
            DataOutbound::Error { message, .. } if message.contains("update consumer dropped")))
                .count(),
            1
        );
        assert_run_removed(&runtime);
        stop(&runtime).await;
    }
}
