//! Real authenticated connector advertisements must agree across both HTTP APIs.
#![cfg(feature = "integration")]

use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};
use sha1::Sha1;
use sqlx::PgPool;
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

#[path = "support/gateway.rs"]
mod gateway;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct Fixture {
    _gateway: gateway::TestGateway,
    client: Client,
    base: String,
    token: String,
    bot: Uuid,
    channel: Uuid,
    credential: String,
}

impl Fixture {
    async fn start(db: &PgPool) -> Self {
        let password = Uuid::new_v4().to_string();
        let (gateway, base) = gateway::TestGateway::start(db, "options-admin", &password).await;
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap();
        let response = client
            .post(format!("{base}/api/v1/auth/login"))
            .json(&json!({"login":"options-admin","password":password}))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        let auth: Value = response.json().await.unwrap();
        let fixture = Self {
            _gateway: gateway,
            client,
            base,
            token: auth["access_token"].as_str().unwrap().into(),
            bot: Uuid::new_v4(),
            channel: Uuid::nil(),
            credential: server::infra::crypto::generate_host_credential(),
        };
        // Exercise the real remote-access gate instead of seeding an armed
        // factor or bypassing the session endpoint's step-up requirement.
        let setup = fixture
            .request(Method::POST, "/auth/2fa/setup", None, StatusCode::OK)
            .await;
        fixture
            .request(
                Method::POST,
                "/auth/2fa/enable",
                Some(json!({"code": authenticator_code(setup["secret"].as_str().unwrap())})),
                StatusCode::OK,
            )
            .await;
        let workspace = fixture
            .request(
                Method::POST,
                "/workspaces",
                Some(json!({"name":"Options contract"})),
                StatusCode::OK,
            )
            .await;
        let channel = fixture
            .request(
                Method::POST,
                "/channels",
                Some(json!({
                    "workspace_id":workspace["workspace_id"],"name":"catalogue"
                })),
                StatusCode::OK,
            )
            .await;
        let fixture = Self {
            channel: channel["channel_id"].as_str().unwrap().parse().unwrap(),
            ..fixture
        };
        sqlx::query("INSERT INTO bot_accounts(bot_id,username,created_by,external_processor,binding_config) VALUES($1,$2,$3,FALSE,$4)")
            .bind(fixture.bot.to_string()).bind(format!("catalogue-{}", fixture.bot))
            .bind(auth["user_id"].as_str().unwrap())
            .bind(json!({"acp_security":{"require_capability":false},"connector_control":{"configOptions":{"reasoning_effort":"low"}}}))
            .execute(db).await.unwrap();
        sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')")
            .bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO connector_hosts(host_id,bot_id,device_name,status,agent_type,credential_hash) VALUES($1,$2,'Options fixture','active','codex',$3)")
            .bind(Uuid::new_v4().to_string()).bind(fixture.bot.to_string())
            .bind(server::infra::crypto::hash_host_credential(&fixture.credential)).execute(db).await.unwrap();
        fixture
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        expected: StatusCode,
    ) -> Value {
        let mut request = self
            .client
            .request(method, format!("{}/api/v1{path}", self.base))
            .bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        let body: Value = serde_json::from_str(&text)
            .unwrap_or_else(|error| panic!("{path}: {status}: {error}: {text}"));
        // Creation endpoints may legitimately use 201; the other assertions
        // retain exact success/error status checks.
        if expected == StatusCode::OK {
            assert!(status.is_success(), "{path}: {status}: {body}");
        } else {
            assert_eq!(status, expected, "{path}: {body}");
        }
        body
    }

    async fn socket(&self, stream: &str) -> Socket {
        let (mut socket, _) = connect_async(format!(
            "{}/ws/agent-bridge/{stream}",
            self.base.replacen("http:", "ws:", 1)
        ))
        .await
        .unwrap();
        send(
            &mut socket,
            json!({"type":"auth","v":1,"token":self.credential,"bridge_protocol_version":1}),
        )
        .await;
        assert_eq!(
            next_type(&mut socket, "hello").await["bot_id"],
            self.bot.to_string()
        );
        socket
    }

    async fn permissions(&self) -> Value {
        self.request(
            Method::GET,
            &format!("/bots/{}/permissions", self.bot),
            None,
            StatusCode::OK,
        )
        .await
    }

    async fn controls(&self) -> Value {
        self.request(
            Method::GET,
            &format!(
                "/channels/{}/bots/{}/session-controls",
                self.channel, self.bot
            ),
            None,
            StatusCode::OK,
        )
        .await
    }

    async fn raw(&self, db: &PgPool) -> Value {
        sqlx::query_scalar("SELECT binding_config #> '{connector_control,options,options}' FROM bot_accounts WHERE bot_id=$1")
            .bind(self.bot.to_string()).fetch_one(db).await.unwrap()
    }
}

/// Independent RFC 6238 client for the fixture's authenticator enrollment.
fn authenticator_code(secret: &str) -> String {
    let mut key = Vec::new();
    let (mut buffer, mut bits) = (0u32, 0u32);
    for byte in secret.bytes() {
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'2'..=b'7' => byte - b'2' + 26,
            _ => panic!("unexpected base32 authenticator secret"),
        };
        buffer = (buffer << 5) | u32::from(digit);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            key.push((buffer >> bits) as u8);
        }
    }
    let mut mac = Hmac::<Sha1>::new_from_slice(&key).unwrap();
    mac.update(&(chrono::Utc::now().timestamp() as u64 / 30).to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = usize::from(digest[19] & 0x0f);
    let binary = u32::from_be_bytes(digest[offset..offset + 4].try_into().unwrap());
    format!("{:06}", (binary & 0x7fff_ffff) % 1_000_000)
}

async fn send(socket: &mut Socket, frame: Value) {
    socket.send(Message::Text(frame.to_string())).await.unwrap();
}

async fn next_type(socket: &mut Socket, expected: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match socket.next().await.expect("bridge remains open").unwrap() {
                Message::Text(text) => {
                    let frame: Value = serde_json::from_str(&text).unwrap();
                    assert_ne!(frame["type"], "bridge_error", "{frame}");
                    if frame["type"] == expected {
                        return frame;
                    }
                }
                Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
                Message::Close(reason) => panic!("bridge closed: {reason:?}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("expected bridge {expected}"))
}

/// WS Ping is processed after the preceding application frame, including its DB
/// write. This proves persistence without sleeps or eventually-passing polls.
async fn barrier(socket: &mut Socket) {
    let nonce = Uuid::new_v4().as_bytes().to_vec();
    socket.send(Message::Ping(nonce.clone())).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match socket.next().await.expect("bridge remains open").unwrap() {
                Message::Pong(bytes) if bytes == nonce => break,
                Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
                Message::Text(text) => {
                    let frame: Value = serde_json::from_str(&text).unwrap();
                    assert_ne!(frame["type"], "bridge_error", "{frame}");
                }
                Message::Close(reason) => panic!("bridge closed: {reason:?}"),
                _ => {}
            }
        }
    })
    .await
    .expect("ordered bridge Pong barrier");
}

#[sqlx::test]
async fn grouped_connector_options_reach_both_apis_and_validate_both_setters(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let mut control = fixture.socket("control").await;
    let _data = fixture.socket("data").await;
    send(
        &mut control,
        json!({"type":"ready","v":1,"connector_capabilities":{
            "task_acceptance":true,"terminal_replay":true,"config_options":true
        }}),
    )
    .await;
    barrier(&mut control).await;
    // An older agent's native model state is also a valid advertisement; both
    // HTTP surfaces must synthesize the same selectable vocabulary.
    send(&mut control, json!({"type":"config_options","v":1,"options":{
        "models":{"currentModelId":"native-only","availableModels":[{"modelId":"native-only","name":"Native"}]}
    }})).await;
    barrier(&mut control).await;
    let native = fixture.controls().await["config_options"].clone();
    assert_eq!(native[0]["id"], "model");
    assert_eq!(
        native[0]["options"],
        json!([{"value":"native-only","name":"Native"}])
    );
    assert_eq!(
        fixture.permissions().await["config_options"]["advertised"],
        native
    );
    let raw_options = json!([
        {"id":"model","category":"model","name":"Model","type":"select","currentValue":"small","options":[
            {"group":"budget-tier","name":"Budget","options":[{"value":"small","name":"Small"}]},
            {"group":"premium-tier","name":"Premium","options":[{"value":"large","name":"Large"}]}
        ]},
        {"id":"reasoning_effort","name":"Reasoning","type":"select","currentValue":"low","options":[
            {"value":"low","name":"Low"},{"value":"high","name":"High"}
        ]}
    ]);
    let models = json!({"currentModelId":"native-only","availableModels":[{"modelId":"native-only","name":"Native"}]});
    send(&mut control, json!({"type":"config_options","v":1,"options":{
        "source":"acp","configOptions":raw_options,"models":models,"currentModelId":"native-only"
    }})).await;
    barrier(&mut control).await;
    let permissions = fixture.permissions().await;
    let controls = fixture.controls().await;
    assert_eq!(
        permissions["config_options"]["advertised"],
        controls["config_options"]
    );
    let advertised = &controls["config_options"];
    assert_eq!(
        advertised.as_array().unwrap().len(),
        2,
        "no duplicate native model option"
    );
    assert_eq!(
        advertised[0]["options"],
        json!([
            {"value":"small","name":"Budget · Small"},{"value":"large","name":"Premium · Large"}
        ])
    );
    assert_eq!(
        fixture.raw(&db).await["configOptions"],
        raw_options,
        "persistence retains original ACP groups"
    );

    send(
        &mut control,
        json!({"type":"config_options","v":1,"options":{
            "source":"acp","sessionUpdate":"available_commands_update",
            "availableCommands":[{"name":"help","description":"Help"}],
            "configOptions":null,"models":null,"currentModelId":null
        }}),
    )
    .await;
    barrier(&mut control).await;
    let raw = fixture.raw(&db).await;
    assert_eq!(raw["configOptions"], raw_options);
    assert_eq!(raw["models"], models);
    assert_eq!(raw["currentModelId"], "native-only");
    assert_eq!(raw["availableCommands"][0]["name"], "help");
    assert_eq!(
        fixture.permissions().await["config_options"]["advertised"],
        *advertised
    );
    assert_eq!(fixture.controls().await["config_options"], *advertised);

    let bot_set = format!("/bots/{}/permissions/config-option", fixture.bot);
    fixture
        .request(
            Method::PUT,
            &bot_set,
            Some(json!({"config_id":"model","value":"large"})),
            StatusCode::OK,
        )
        .await;
    let bot_update = next_type(&mut control, "config_update").await;
    assert_eq!(
        bot_update["settings"]["configOptions"],
        json!({"model":"large","reasoning_effort":"low"})
    );
    let session = fixture
        .request(
            Method::POST,
            &format!(
                "/channels/{}/bots/{}/sessions",
                fixture.channel, fixture.bot
            ),
            Some(json!({})),
            StatusCode::OK,
        )
        .await;
    let session_id = session["session_id"].as_str().unwrap();
    let session_set = format!(
        "/channels/{}/bots/{}/sessions/{session_id}/config-option",
        fixture.channel, fixture.bot
    );
    fixture
        .request(
            Method::POST,
            &session_set,
            Some(json!({"config_id":"model","value":"small"})),
            StatusCode::OK,
        )
        .await;
    let session_update = next_type(&mut control, "config_option_set").await;
    assert_eq!(
        session_update["provider_session_key"],
        session["provider_session_key"]
    );
    assert_eq!(
        session_update["session_config"]["config_options"],
        json!({"model":"small"})
    );

    for (method, path) in [(Method::PUT, &bot_set), (Method::POST, &session_set)] {
        for body in [
            json!({"config_id":"model","value":"premium-tier"}),
            json!({"config_id":"unknown","value":"large"}),
        ] {
            fixture
                .request(method.clone(), path, Some(body), StatusCode::BAD_REQUEST)
                .await;
        }
    }
    assert_eq!(
        fixture.permissions().await["config_options"]["desired"],
        json!({"model":"large","reasoning_effort":"low"})
    );
    let sessions = fixture
        .request(
            Method::GET,
            &format!(
                "/channels/{}/bots/{}/sessions",
                fixture.channel, fixture.bot
            ),
            None,
            StatusCode::OK,
        )
        .await;
    let saved = sessions["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["session_id"] == session_id)
        .unwrap();
    assert_eq!(
        saved["session_config"]["config_options"],
        json!({"model":"small"})
    );
    assert_eq!(fixture.raw(&db).await["configOptions"], raw_options);
    assert_eq!(fixture.controls().await["config_options"], *advertised);
}
