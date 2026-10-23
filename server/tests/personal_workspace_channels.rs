//! Personal ownership provisions the workspace membership required by channels.
#![cfg(feature = "integration")]

use std::time::Duration;

use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/gateway.rs"]
mod gateway;

struct User {
    id: Uuid,
    token: String,
}

struct Fixture {
    _gateway: gateway::TestGateway,
    base: String,
    client: Client,
}

impl Fixture {
    async fn start(db: &PgPool) -> Self {
        let (gateway, base) =
            gateway::TestGateway::start(db, "personal-channel-admin", &Uuid::new_v4().to_string())
                .await;
        Self {
            _gateway: gateway,
            base,
            client: Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap(),
        }
    }

    async fn user(&self, db: &PgPool) -> User {
        let id = Uuid::new_v4();
        let login = format!("personal-{id}");
        let password = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO users(user_id,username,password_hash,role) VALUES($1,$2,$3,'member')",
        )
        .bind(id.to_string())
        .bind(&login)
        .bind(bcrypt::hash(&password, 4).unwrap())
        .execute(db)
        .await
        .unwrap();
        let (status, auth) = self
            .request(
                "",
                Method::POST,
                "/auth/login",
                Some(json!({"login":login,"password":password,"client":"macos"})),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{auth}");
        assert_eq!(auth["status"], "authenticated");
        assert_eq!(auth["role"], "member");
        assert_eq!(auth["user_id"], id.to_string());
        User {
            id,
            token: auth["access_token"].as_str().unwrap().into(),
        }
    }

    async fn request(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = self
            .client
            .request(method, format!("{}/api/v1{path}", self.base));
        if !token.is_empty() {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        (status, response.json().await.unwrap())
    }

    async fn create(&self, user: &User, workspace: Uuid, kind: &str) -> Value {
        let (status, channel) = self
            .request(
                &user.token,
                Method::POST,
                "/channels",
                Some(json!({
                    "workspace_id":workspace,
                    "name":format!("Personal {kind}"),
                    "type":kind,
                })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{channel}");
        assert_eq!(channel["workspace_id"], workspace.to_string());
        assert_eq!(channel["type"], kind);
        channel
    }
}

async fn legacy_personal(db: &PgPool, owner: Uuid) -> Uuid {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspaces(workspace_id,name,kind,owner_user_id) VALUES($1,'Existing Personal','personal',$2)")
        .bind(workspace.to_string()).bind(owner.to_string()).execute(db).await.unwrap();
    workspace
}

async fn membership(db: &PgPool, workspace: Uuid, user: Uuid) -> Option<(String, String)> {
    sqlx::query_as(
        "SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace.to_string())
    .bind(user.to_string())
    .fetch_optional(db)
    .await
    .unwrap()
}

async fn assert_owner(db: &PgPool, workspace: Uuid, user: Uuid) {
    assert_eq!(
        membership(db, workspace, user).await,
        Some(("owner".into(), "active".into()))
    );
}

async fn assert_channel_owner(db: &PgPool, channel: &Value, user: Uuid) {
    let role: String = sqlx::query_scalar(
        "SELECT role FROM channel_memberships WHERE channel_id=$1 AND member_id=$2 AND member_type='user'",
    )
    .bind(channel["channel_id"].as_str().unwrap())
    .bind(user.to_string())
    .fetch_one(db)
    .await
    .unwrap();
    assert_eq!(role, "owner");
}

#[sqlx::test]
async fn personal_lookup_provisions_and_repairs_only_its_owner(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let fresh = fixture.user(&db).await;
    let (status, personal) = fixture
        .request(&fresh.token, Method::GET, "/workspaces/personal", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{personal}");
    let workspace: Uuid = personal["workspace_id"].as_str().unwrap().parse().unwrap();
    assert_eq!(personal["kind"], "personal");
    assert_owner(&db, workspace, fresh.id).await;

    // Both the old fast-return branch and an existing damaged membership need
    // repair, without replacing the workspace or its membership's join history.
    let older = fixture.user(&db).await;
    let old_workspace = legacy_personal(&db, older.id).await;
    for existing_membership in [false, true] {
        if existing_membership {
            sqlx::query("UPDATE workspace_memberships SET role='readonly',status='pending',joined_at='2000-01-01T00:00:00Z' WHERE workspace_id=$1 AND user_id=$2")
                .bind(old_workspace.to_string()).bind(older.id.to_string()).execute(&db).await.unwrap();
        }
        let (status, repaired) = fixture
            .request(&older.token, Method::GET, "/workspaces/personal", None)
            .await;
        assert_eq!(status, StatusCode::OK, "{repaired}");
        assert_eq!(repaired["workspace_id"], old_workspace.to_string());
        assert_owner(&db, old_workspace, older.id).await;
    }
    let preserved: bool = sqlx::query_scalar("SELECT joined_at='2000-01-01T00:00:00Z'::timestamptz FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2")
        .bind(old_workspace.to_string()).bind(older.id.to_string()).fetch_one(&db).await.unwrap();
    assert!(preserved);
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workspaces WHERE kind='personal' AND owner_user_id=$1",
    )
    .bind(older.id.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(count, 1);
    assert!(membership(&db, old_workspace, fresh.id).await.is_none());
}

#[sqlx::test]
async fn ordinary_owner_can_create_public_and_private_channels_in_new_personal(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let owner = fixture.user(&db).await;
    let (status, personal) = fixture
        .request(&owner.token, Method::GET, "/workspaces/personal", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{personal}");
    let workspace = personal["workspace_id"].as_str().unwrap().parse().unwrap();
    for kind in ["public", "private"] {
        let channel = fixture.create(&owner, workspace, kind).await;
        assert_channel_owner(&db, &channel, owner.id).await;
        let (status, channels) = fixture
            .request(
                &owner.token,
                Method::GET,
                &format!("/channels?workspace_id={workspace}"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{channels}");
        assert!(channels
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["channel_id"] == channel["channel_id"]));
    }
    assert_owner(&db, workspace, owner.id).await;
}

#[sqlx::test]
async fn direct_creation_repairs_legacy_personal_without_a_prior_lookup(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    for kind in ["public", "private"] {
        let owner = fixture.user(&db).await;
        let workspace = legacy_personal(&db, owner.id).await;
        assert!(membership(&db, workspace, owner.id).await.is_none());
        // Do not call /workspaces/personal: existing clients may retain this ID.
        let channel = fixture.create(&owner, workspace, kind).await;
        assert_owner(&db, workspace, owner.id).await;
        assert_channel_owner(&db, &channel, owner.id).await;
    }
}

#[sqlx::test]
async fn foreign_personal_and_inactive_team_do_not_gain_membership(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let caller = fixture.user(&db).await;
    let other = fixture.user(&db).await;
    let personal = legacy_personal(&db, other.id).await;
    // Even a matching owner_user_id on a team row is not personal ownership.
    let team = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO workspaces(workspace_id,name,kind,owner_user_id) VALUES($1,'Team','team',$2)",
    )
    .bind(team.to_string())
    .bind(caller.id.to_string())
    .execute(&db)
    .await
    .unwrap();
    for workspace in [personal, team] {
        for kind in ["public", "private"] {
            let (status, error) = fixture
                .request(
                    &caller.token,
                    Method::POST,
                    "/channels",
                    Some(json!({"workspace_id":workspace,"name":"Forbidden","type":kind})),
                )
                .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
            assert_eq!(error["detail"], "forbidden: workspace member required");
            assert!(membership(&db, workspace, caller.id).await.is_none());
        }
    }
    assert!(membership(&db, personal, other.id).await.is_none());
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'member','pending')")
        .bind(team.to_string()).bind(caller.id.to_string()).execute(&db).await.unwrap();
    let (status, _) = fixture
        .request(
            &caller.token,
            Method::POST,
            "/channels",
            Some(json!({"workspace_id":team,"name":"Still pending"})),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        membership(&db, team, caller.id).await,
        Some(("member".into(), "pending".into()))
    );
    sqlx::query(
        "UPDATE workspace_memberships SET status='active' WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(team.to_string())
    .bind(caller.id.to_string())
    .execute(&db)
    .await
    .unwrap();
    for kind in ["public", "private"] {
        fixture.create(&caller, team, kind).await;
    }
    assert_eq!(
        membership(&db, team, caller.id).await,
        Some(("member".into(), "active".into()))
    );
}

#[sqlx::test]
async fn channel_creation_errors_roll_back_membership_repair_and_channel(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    sqlx::raw_sql("CREATE FUNCTION reject_personal_channel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected personal channel commit failure'; END $$; CREATE CONSTRAINT TRIGGER reject_personal_channel AFTER INSERT ON channels DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.name='Commit failure') EXECUTE FUNCTION reject_personal_channel();")
        .execute(&db).await.unwrap();
    for commit_failure in [false, true] {
        let owner = fixture.user(&db).await;
        let workspace = legacy_personal(&db, owner.id).await;
        let body = if commit_failure {
            json!({"workspace_id":workspace,"name":"Commit failure","type":"private"})
        } else {
            // Public invite validation fails after the channel and owner were
            // inserted, exercising the ordinary application rollback path.
            json!({"workspace_id":workspace,"name":"Invalid invitation","type":"public","initial_user_ids":[Uuid::new_v4()]})
        };
        let (status, error) = fixture
            .request(&owner.token, Method::POST, "/channels", Some(body))
            .await;
        assert_eq!(
            status,
            if commit_failure {
                StatusCode::INTERNAL_SERVER_ERROR
            } else {
                StatusCode::BAD_REQUEST
            },
            "{error}"
        );
        assert!(membership(&db, workspace, owner.id).await.is_none());
        let counts: (i64, i64) = sqlx::query_as("SELECT (SELECT COUNT(*) FROM channels WHERE workspace_id=$1),(SELECT COUNT(*) FROM channel_memberships WHERE member_id=$2)")
            .bind(workspace.to_string()).bind(owner.id.to_string()).fetch_one(&db).await.unwrap();
        assert_eq!(counts, (0, 0));
        fixture.create(&owner, workspace, "private").await;
        assert_owner(&db, workspace, owner.id).await;
    }
}

#[sqlx::test]
async fn opening_a_dm_materializes_only_the_anchor_owner_not_the_peer(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let owner = fixture.user(&db).await;
    let peer = fixture.user(&db).await;
    let mut pair = [owner.id.to_string(), peer.id.to_string()];
    pair.sort();
    sqlx::query("INSERT INTO friendships(friendship_id,user_id,friend_id,pair_key,status) VALUES($1,$2,$3,$4,'accepted')")
        .bind(Uuid::new_v4().to_string()).bind(owner.id.to_string()).bind(peer.id.to_string()).bind(pair.join(":" )).execute(&db).await.unwrap();
    let (status, dm) = fixture
        .request(
            &owner.token,
            Method::POST,
            "/channels/dm",
            Some(json!({"target_user_id":peer.id})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{dm}");
    assert_eq!(dm["type"], "dm");
    let workspace = dm["workspace_id"].as_str().unwrap().parse().unwrap();
    assert_owner(&db, workspace, owner.id).await;
    assert!(membership(&db, workspace, peer.id).await.is_none());
    let peers: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM channel_memberships WHERE channel_id=$1 AND member_type='user'",
    )
    .bind(dm["channel_id"].as_str().unwrap())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(peers, 2);
}
