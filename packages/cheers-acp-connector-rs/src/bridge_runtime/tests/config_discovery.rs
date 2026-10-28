//! Discover session options without prompts and retain response-only updates.

use super::*;

// A real stdio peer which never sends a session/update notification. The full
// configuration returned by each response is its only catalogue advertisement.
const CATALOG_AGENT: &str = r#"
import json, sys
model = 'base'
def catalogue(selected):
    reasoning = ['low', 'high'] if selected == 'extended' else ['low']
    return [
        {'id': 'model', 'name': 'Model', 'type': 'select', 'currentValue': selected,
         'options': [{'value': value, 'name': value} for value in ['base', 'extended']]},
        {'id': 'reasoning_effort', 'name': 'Reasoning', 'type': 'select',
         'currentValue': 'low',
         'options': [{'value': value, 'name': value} for value in reasoning]}]
def snapshot():
    return {'configOptions': catalogue(model), 'models': {
        'currentModelId': model,
        'availableModels': [{'modelId': value, 'name': value} for value in ['base', 'extended']]}}
for line in sys.stdin:
    request = json.loads(line)
    method, params = request.get('method'), request.get('params', {})
    with open(sys.argv[1], 'a', encoding='utf-8') as journal:
        journal.write(json.dumps({'method': method}) + '\n')
    if method == 'initialize':
        result = {'protocolVersion': params['protocolVersion'], 'agentCapabilities': {
            'loadSession': True, 'mcpCapabilities': {'http': True}}, 'authMethods': []}
    elif method == 'session/new':
        model = 'base'
        result = dict(snapshot(), sessionId='catalogue-session')
    elif method == 'session/load':
        # Deliberately restore an old initial value. The persisted desired
        # override must be applied and reported AFTER this initial snapshot.
        model = 'base'
        result = snapshot()
    elif method == 'session/set_config_option' and params['configId'] == 'model':
        model = params['value']
        result = {'configOptions': catalogue(model)}
    else:
        print(json.dumps({'jsonrpc': '2.0', 'id': request.get('id'), 'error': {
            'code': -32601, 'message': 'unexpected fixture method: ' + str(method)}}), flush=True)
        continue
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
"#;

async fn catalogue_runtime(
    dir: &Path,
    legacy: bool,
) -> (
    Arc<RuntimeContext>,
    RuntimeTaps,
    mpsc::Receiver<RuntimeEvent>,
    PathBuf,
) {
    let (mut runtime, _, _release, taps) = fixture_runtime(dir, PromptGate::All, 4).await;
    let script = dir.join("catalogue_agent.py");
    let journal = dir.join("catalogue_calls.jsonl");
    tokio::fs::write(&script, CATALOG_AGENT).await.unwrap();
    let context = Arc::get_mut(&mut runtime).unwrap();
    context.config.policy.config.allowed_config_options =
        vec!["model".into(), "reasoning_effort".into()];
    context.config.agent.cwd = Some(dir.canonicalize().unwrap());
    let mut config = context.config.agent.clone();
    config.command = "python3".into();
    config.args = vec![
        "-I".into(),
        "-u".into(),
        script.display().to_string(),
        journal.display().to_string(),
    ];
    config.env.clear();
    config.env.insert("HOME".into(), dir.display().to_string());
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
        .expect("initialize the isolated real stdio fixture")
        .unwrap();
    context.adapter = Arc::new(Mutex::new(adapter));
    (runtime, taps, receiver, journal)
}

async fn session_control(runtime: &Arc<RuntimeContext>, action: &str) {
    let frame = serde_json::from_value(json!({
        "type":"runtime_session_control", "v":BRIDGE_PROTOCOL_VERSION,
        "request_id":format!("catalogue-{action}"), "action":action,
        "session":{
            "id":"cheers-catalogue-session",
            "provider_session_key":"cheers:catalogue",
            "primary_scope_type":"channel", "primary_scope_id":"catalogue-channel"
        },
        "runtime":{"protocol":"acp"}
    }))
    .unwrap();
    timeout(
        Duration::from_secs(5),
        runtime.clone().handle_control(frame),
    )
    .await
    .expect("runtime session control finishes without a prompt")
    .unwrap();
}

async fn next_control(taps: &mut RuntimeTaps) -> ControlOutbound {
    timeout(Duration::from_secs(5), taps._control.recv())
        .await
        .expect("runtime publishes its advertisement or acknowledgement")
        .expect("control writer remains open")
}

async fn snapshot(taps: &mut RuntimeTaps) -> Value {
    match next_control(taps).await {
        ControlOutbound::ConfigOptions { options, .. } => options,
        frame => panic!("expected a complete catalogue, got {frame:?}"),
    }
}

async fn session_ack(taps: &mut RuntimeTaps, action: &str) {
    assert!(matches!(
        next_control(taps).await,
        ControlOutbound::RuntimeSessionControlAck { ok:true, action:actual, .. } if actual == action
    ));
}

fn methods(journal: &Path) -> Vec<String> {
    std::fs::read_to_string(journal)
        .unwrap()
        .lines()
        .map(|line| {
            serde_json::from_str::<Value>(line).unwrap()["method"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}

async fn stop(runtime: &RuntimeContext) {
    timeout(Duration::from_secs(5), async {
        runtime.adapter.lock().await.stop().await
    })
    .await
    .unwrap()
    .unwrap();
}

#[tokio::test]
async fn explicit_session_creation_discovers_options_without_any_prompt() {
    for legacy in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (runtime, mut taps, mut events, journal) = catalogue_runtime(dir.path(), legacy).await;
        assert!(taps._control.try_recv().is_err());
        session_control(&runtime, "create").await;
        let discovered = snapshot(&mut taps).await;
        assert_eq!(discovered["configOptions"][0]["currentValue"], "base");
        assert_eq!(
            discovered["models"]["availableModels"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(discovered["currentModelId"], "base");
        session_ack(&mut taps, "create").await;
        assert_eq!(methods(&journal), ["initialize", "session/new"]);
        assert!(
            events.try_recv().is_err(),
            "the fixture emits no notifications"
        );
        assert!(taps._control.try_recv().is_err());
        stop(&runtime).await;
    }
}

#[tokio::test]
async fn setter_response_refreshes_catalogue_and_load_cannot_restore_old_snapshot() {
    for legacy in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (runtime, mut taps, mut events, journal) = catalogue_runtime(dir.path(), legacy).await;
        session_control(&runtime, "create").await;
        let _initial = snapshot(&mut taps).await;
        session_ack(&mut taps, "create").await;
        timeout(
            Duration::from_secs(5),
            runtime.handle_config_option_set(
                "catalogue-change".into(),
                None,
                Some("cheers:catalogue".into()),
                "model".into(),
                "extended".into(),
                Some(SessionConfigOverrides {
                    revision: 1,
                    config_options: BTreeMap::from([("model".into(), "extended".into())]),
                    ..Default::default()
                }),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        let updated = snapshot(&mut taps).await;
        assert_eq!(updated["configOptions"][0]["currentValue"], "extended");
        assert_eq!(updated["configOptions"][1]["options"][1]["value"], "high");
        assert!(matches!(
            next_control(&mut taps).await,
            ControlOutbound::ConfigOptionStatus { ok:true, request_id, .. }
                if request_id == "catalogue-change"
        ));

        session_control(&runtime, "resume").await;
        let loaded = snapshot(&mut taps).await;
        let reconciled = snapshot(&mut taps).await;
        assert_eq!(loaded["configOptions"][0]["currentValue"], "base");
        assert_eq!(reconciled["configOptions"], updated["configOptions"]);
        session_ack(&mut taps, "resume").await;
        assert!(
            taps._control.try_recv().is_err(),
            "no stale snapshot follows reconciliation"
        );
        assert!(
            events.try_recv().is_err(),
            "response-only updates need no notification"
        );
        assert_eq!(
            methods(&journal),
            [
                "initialize",
                "session/new",
                "session/set_config_option",
                "session/load",
                "session/set_config_option"
            ]
        );
        stop(&runtime).await;
    }
}
