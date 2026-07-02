//! R4-2 集成测试：对真实 Postgres 跑核心数据流不变量（白盒，直接调真实函数）。
//!
//! 用 `#[sqlx::test]`：每个测试拿到一个隔离的临时数据库（自动建库 + 跑
//! `./migrations` + 测后删库）。运行需 `DATABASE_URL` 指向一个可 CREATE DATABASE
//! 的 Postgres（CLAUDE.md：URL 走环境变量，不硬编码端口），例如：
//!
//! ```bash
//! DATABASE_URL=postgres://cheers:cheers@localhost:5432/cheers \
//!   cargo test --test flows
//! ```
//!
//! 覆盖：I2（channel_seq gap-free）、流程 2（create_message 落库 + 连续 seq）、
//! 流程 8（since-seq 补齐）、流程 4（done finalize + 幂等）、R5（并发 dispatch 只派一次）。
//!
//! 用 feature `integration` 门控：默认 `cargo test`（单测 job）不跑这些、无需 DB；
//! 集成 job 跑 `cargo test --features integration --test flows`。
#![cfg(feature = "integration")]

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use async_trait::async_trait;
use serde_json::Value;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use server::domain::channel_seq;
use server::domain::dms;
use server::domain::messages::{self, CreateMessageParams};
use server::domain::workbench_templates;
use server::domain::workspaces;
use server::gateway::dispatcher::{self, DispatchParams, DispatchResult};
use server::gateway::realtime::fanout::{Fanout, InProcessFanout};
use server::gateway::registry::{BotLocator, InProcessBotLocator};
use server::gateway::stream::{self, StreamRegistry};
use server::resource::files;

// ── 测试夹具（最小行）──────────────────────────────────────────────────────────

async fn seed_workspace(db: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspaces (workspace_id, name) VALUES ($1, 'test-ws')")
        .bind(id.to_string())
        .execute(db)
        .await
        .unwrap();
    id
}

async fn seed_channel(db: &PgPool, workspace_id: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO channels (channel_id, workspace_id, name) VALUES ($1, $2, 'general')")
        .bind(id.to_string())
        .bind(workspace_id.to_string())
        .execute(db)
        .await
        .unwrap();
    id
}

async fn seed_user(db: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (user_id, username, password_hash, display_name)
         VALUES ($1, $2, 'x', 'Tester')",
    )
    .bind(id.to_string())
    .bind(format!("u-{id}")) // username 唯一
    .execute(db)
    .await
    .unwrap();
    id
}

async fn add_member(db: &PgPool, channel_id: Uuid, member_id: Uuid, member_type: &str) {
    add_member_role(db, channel_id, member_id, member_type, "member").await;
}

async fn add_member_role(
    db: &PgPool,
    channel_id: Uuid,
    member_id: Uuid,
    member_type: &str,
    role: &str,
) {
    sqlx::query(
        "INSERT INTO channel_memberships (channel_id, member_id, member_type, role)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(channel_id.to_string())
    .bind(member_id.to_string())
    .bind(member_type)
    .bind(role)
    .execute(db)
    .await
    .unwrap();
}

fn fanout() -> Arc<dyn Fanout> {
    InProcessFanout::new()
}

// ── I2：channel_seq 并发分配 gap-free ─────────────────────────────────────────

/// 多个事务并发各分配一个 seq（行锁下序列化）。结果必为 1..=N 无洞无重，
/// 即 seq 序 == 提交序。
#[sqlx::test]
async fn i2_channel_seq_is_gap_free_under_concurrency(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;

    const N: i64 = 50;
    let mut handles = Vec::new();
    for _ in 0..N {
        let db = db.clone();
        handles.push(tokio::spawn(async move {
            let mut tx = db.begin().await.unwrap();
            let seq = channel_seq::allocate(&mut tx, ch).await.unwrap();
            tx.commit().await.unwrap();
            seq
        }));
    }

    let mut seqs = Vec::new();
    for h in handles {
        seqs.push(h.await.unwrap());
    }
    seqs.sort_unstable();

    let expected: Vec<i64> = (1..=N).collect();
    assert_eq!(seqs, expected, "channel_seq 必须连续无洞无重 (1..={N})");
}

// ── 流程 2 + I1：create_message 落库并分配连续 seq ────────────────────────────

/// 顺序发 N 条用户消息，每条返回的 seq 必须 1..N 连续，且落库 is_partial=FALSE。
/// 然后流程 8：since-seq 从 0 拉，应按 seq 升序拿到全部 N 条且无洞。
#[sqlx::test]
async fn flow2_create_message_assigns_contiguous_seq_and_since_seq_backfills(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let user = seed_user(&db).await;
    add_member(&db, ch, user, "user").await;

    let fanout = fanout();
    let registry = StreamRegistry::new();
    let bot_locator: Arc<dyn BotLocator> = InProcessBotLocator::new();

    const N: i64 = 5;
    for i in 0..N {
        let dto = messages::create_message(
            &db,
            &fanout,
            &registry,
            &bot_locator,
            CreateMessageParams {
                user_id: user,
                channel_id: ch,
                content: format!("msg {i}"),
                msg_type: None,
                reply_to_msg_id: None,
                file_ids: vec![],
                mention_ids: vec![],
                session_id: None, // 默认 = 频道 primary session（本测试不针对 other session）
            },
        )
        .await
        .unwrap();
        assert_eq!(dto.channel_seq, Some(i + 1), "第 {i} 条 seq 应为 {}", i + 1);
    }

    // 流程 8：断线补齐——since-seq 从 0 拉全部，gap-free 升序。
    let page = messages::list_channel_messages_since_seq(&db, &ch, 0, 200)
        .await
        .unwrap();
    let seqs: Vec<i64> = page.messages.iter().filter_map(|m| m.channel_seq).collect();
    assert_eq!(
        seqs,
        (1..=N).collect::<Vec<_>>(),
        "since-seq 应连续返回 1..={N}"
    );

    // since-seq 从中间拉只返回更大的 seq。
    let page = messages::list_channel_messages_since_seq(&db, &ch, 2, 200)
        .await
        .unwrap();
    let seqs: Vec<i64> = page.messages.iter().filter_map(|m| m.channel_seq).collect();
    assert_eq!(seqs, vec![3, 4, 5], "since-seq=2 应只返回 3,4,5");
}

// ── R5：并发 dispatch 同一 (trigger, bot) 只派一次 task ───────────────────────

/// 计数用的 BotLocator 测试替身：永远“在线”，记录 dispatch_task 调用次数。
#[derive(Default)]
struct CountingBotLocator {
    dispatched: AtomicUsize,
}

#[async_trait]
impl BotLocator for CountingBotLocator {
    async fn dispatch_task(&self, _bot_id: Uuid, _task: Value) -> bool {
        self.dispatched.fetch_add(1, Ordering::SeqCst);
        true // 在线，投递成功
    }
    async fn send_data(&self, _bot_id: Uuid, _frame: Value) -> bool {
        true
    }
    fn is_online(&self, _bot_id: Uuid) -> bool {
        true
    }
}

/// 并发双触发同一 (trigger_msg_id, bot_id)：占位由 INSERT…ON CONFLICT 单点定胜负，
/// 只有胜者派发 task。断言 dispatch_task 恰好调用一次，且只落一条占位。
#[sqlx::test]
async fn r5_concurrent_dispatch_dispatches_task_exactly_once(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;

    let fanout = fanout();
    let registry = StreamRegistry::new();
    let counter = Arc::new(CountingBotLocator::default());
    let bot_locator: Arc<dyn BotLocator> = counter.clone();

    let trigger = Uuid::new_v4();
    let bot = Uuid::new_v4();

    let make_params = || DispatchParams {
        trigger_msg_id: trigger,
        trigger_seq: 0,
        bot_id: bot,
        channel_id: ch,
        depth: 0,
        provider_session_key: "cheers:test".into(),
        session_id: None,
    };

    // 两个并发 dispatch 抢同一占位。
    let (a, b) = {
        let (db1, f1, r1, l1, p1) = (
            db.clone(),
            fanout.clone(),
            registry.clone(),
            bot_locator.clone(),
            make_params(),
        );
        let (db2, f2, r2, l2, p2) = (
            db.clone(),
            fanout.clone(),
            registry.clone(),
            bot_locator.clone(),
            make_params(),
        );
        let h1 = tokio::spawn(async move { dispatcher::dispatch(&db1, &f1, &r1, &l1, p1).await });
        let h2 = tokio::spawn(async move { dispatcher::dispatch(&db2, &f2, &r2, &l2, p2).await });
        (h1.await.unwrap(), h2.await.unwrap())
    };

    // 一个胜者 Dispatched，一个败者 AlreadyInProgress（顺序不定）。
    let outcomes = [&a, &b];
    let dispatched = outcomes
        .iter()
        .filter(|r| matches!(r, DispatchResult::Dispatched { .. }))
        .count();
    let already = outcomes
        .iter()
        .filter(|r| matches!(r, DispatchResult::AlreadyInProgress))
        .count();
    assert_eq!(dispatched, 1, "恰好一个 dispatch 胜出");
    assert_eq!(already, 1, "另一个应为 AlreadyInProgress");

    // R5 核心：task 只派发一次。
    assert_eq!(
        counter.dispatched.load(Ordering::SeqCst),
        1,
        "dispatch_task 必须只被调用一次"
    );

    // 只落一条占位行。
    let count: i64 = sqlx::query(
        "SELECT COUNT(*) AS c FROM messages WHERE channel_id = $1 AND sender_type = 'bot'",
    )
    .bind(ch.to_string())
    .fetch_one(&db)
    .await
    .unwrap()
    .try_get("c")
    .unwrap();
    assert_eq!(count, 1, "并发双触发只应产生一条占位");
}

// ── 流程 4：done 落库 finalize；迟到的第二个 done 幂等（不双写、不耗 seq）──────

/// 派发占位 → done 帧 finalize（此刻才分配 seq）。第二个 done 被 DB 守卫
/// （`is_partial=TRUE AND channel_seq IS NULL`）拦截，且其 seq 分配随事务回滚，
/// channels.next_seq 不前进（I2 无洞）。
#[sqlx::test]
async fn flow4_done_finalizes_and_second_done_is_idempotent(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;

    let fanout = fanout();
    let registry = StreamRegistry::new();
    let locator: Arc<dyn BotLocator> = Arc::new(CountingBotLocator::default());
    let bot = Uuid::new_v4();

    // 派发占位（在线 → Dispatched），并注册流。
    let res = dispatcher::dispatch(
        &db,
        &fanout,
        &registry,
        &locator,
        DispatchParams {
            trigger_msg_id: Uuid::new_v4(),
            trigger_seq: 0,
            bot_id: bot,
            channel_id: ch,
            depth: 0,
            provider_session_key: "cheers:test".into(),
            session_id: None,
        },
    )
    .await;
    let placeholder = match res {
        DispatchResult::Dispatched { placeholder_msg_id } => placeholder_msg_id,
        _ => panic!("expected Dispatched"),
    };

    // done 帧 → finalize。
    let frame = serde_json::json!({ "msg_id": placeholder.to_string(), "content": "hello" });
    stream::handle_done(&registry, &fanout, &db, &locator, bot, "", &frame)
        .await
        .expect("first done should finalize");

    let row =
        sqlx::query("SELECT is_partial, channel_seq, content FROM messages WHERE msg_id = $1")
            .bind(placeholder.to_string())
            .fetch_one(&db)
            .await
            .unwrap();
    let is_partial: bool = row.try_get("is_partial").unwrap();
    let seq: Option<i64> = row.try_get("channel_seq").unwrap();
    let content: String = row.try_get("content").unwrap();
    assert!(!is_partial, "done 后占位应 finalize");
    assert_eq!(seq, Some(1), "finalize 时才分配 seq=1（占位期不耗 seq）");
    assert_eq!(content, "hello");

    // 迟到的第二个 done：DB 守卫拦截 → Err。
    let second = stream::handle_done(&registry, &fanout, &db, &locator, bot, "", &frame).await;
    assert!(second.is_err(), "迟到的第二个 done 应被拒绝");

    // I2：第二个 done 的 allocate 随事务回滚，不消费 seq → next_seq 仍为 1。
    let next_seq: i64 = sqlx::query("SELECT next_seq FROM channels WHERE channel_id = $1")
        .bind(ch.to_string())
        .fetch_one(&db)
        .await
        .unwrap()
        .try_get("next_seq")
        .unwrap();
    assert_eq!(next_seq, 1, "二次 finalize 不得消费 seq（事务回滚，无洞）");
}

// ── M2 Slice 0：resource dispatch / fs.* 回归锁 ────────────────────────────────
//
// develop 上 `resource::dispatch` 与 `fs.*` 此前零测试覆盖。Slice 1（user→dispatch
// 桥）会给 dispatch 接入新的 `Principal::user` 入口；这些测试先把现有
// `Principal::bot` 行为（fs 往返、channel-role 鉴权、未知 verb fallback）锁住，
// 作为后续改 dispatch 的安全网。

use server::resource::{dispatch, dispatch_user, Principal};

async fn seed_bot(db: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO bot_accounts (bot_id, username) VALUES ($1, $2)")
        .bind(id.to_string())
        .bind(format!("b-{id}")) // username 唯一
        .execute(db)
        .await
        .unwrap();
    id
}

fn req(resource: &str, params: Value) -> Value {
    serde_json::json!({ "req_id": "t", "resource": resource, "params": params })
}

/// fs.write → read → ls → edit → read → rm → read(404)，全程经 `dispatch`，
/// 用 `Principal::bot` 模拟外接 agent 的资源访问路径。
#[sqlx::test]
async fn m2_fs_roundtrip_through_dispatch(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let bot = seed_bot(&db).await;
    add_member(&db, ch, bot, "bot").await;
    let who = Principal::bot(bot);
    let cid = ch.to_string();

    // write（create-only：if_version=0）
    let r = dispatch(
        &db,
        who,
        &req(
            "fs.write",
            serde_json::json!({ "channel_id": cid, "path": "notes/a.md", "content": "hello", "if_version": 0 }),
        ),
    )
    .await;
    assert_eq!(r["ok"], true, "fs.write 应成功: {r}");
    assert_eq!(r["data"]["version"], 1, "新建文件 version=1");

    // read 回来内容一致
    let r = dispatch(
        &db,
        who,
        &req(
            "fs.read",
            serde_json::json!({ "channel_id": cid, "path": "notes/a.md" }),
        ),
    )
    .await;
    assert_eq!(r["ok"], true);
    assert_eq!(r["data"]["content"], "hello");

    // ls 子树含该文件
    let r = dispatch(
        &db,
        who,
        &req(
            "fs.ls",
            serde_json::json!({ "channel_id": cid, "path": "notes" }),
        ),
    )
    .await;
    assert_eq!(r["ok"], true);
    let paths: Vec<&str> = r["data"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["path"].as_str())
        .collect();
    assert!(
        paths.contains(&"notes/a.md"),
        "ls 应列出 notes/a.md: {paths:?}"
    );

    // edit：string-replace
    let r = dispatch(
        &db,
        who,
        &req(
            "fs.edit",
            serde_json::json!({ "channel_id": cid, "path": "notes/a.md", "old_string": "hello", "new_string": "world" }),
        ),
    )
    .await;
    assert_eq!(r["ok"], true, "fs.edit 应成功: {r}");

    let r = dispatch(
        &db,
        who,
        &req(
            "fs.read",
            serde_json::json!({ "channel_id": cid, "path": "notes/a.md" }),
        ),
    )
    .await;
    assert_eq!(r["data"]["content"], "world", "edit 后内容应更新");

    // rm
    let r = dispatch(
        &db,
        who,
        &req(
            "fs.rm",
            serde_json::json!({ "channel_id": cid, "path": "notes/a.md" }),
        ),
    )
    .await;
    assert_eq!(r["ok"], true, "fs.rm 应成功: {r}");

    // read → NOT_FOUND
    let r = dispatch(
        &db,
        who,
        &req(
            "fs.read",
            serde_json::json!({ "channel_id": cid, "path": "notes/a.md" }),
        ),
    )
    .await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "NOT_FOUND", "删后再读应 NOT_FOUND: {r}");
}

/// 非频道成员的 bot：读写都应 NOT_MEMBER（channel-role 是唯一授权事实源）。
#[sqlx::test]
async fn m2_fs_authz_non_member_rejected(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let outsider = seed_bot(&db).await; // 故意不 add_member
    let who = Principal::bot(outsider);
    let cid = ch.to_string();

    let r = dispatch(
        &db,
        who,
        &req(
            "fs.read",
            serde_json::json!({ "channel_id": cid, "path": "x.md" }),
        ),
    )
    .await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "NOT_MEMBER", "非成员读应 NOT_MEMBER: {r}");

    let r = dispatch(
        &db,
        who,
        &req(
            "fs.write",
            serde_json::json!({ "channel_id": cid, "path": "x.md", "content": "nope" }),
        ),
    )
    .await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "NOT_MEMBER", "非成员写应 NOT_MEMBER: {r}");
}

/// pin：`.workbench.json` 的 `pinned` 列表 + 文件内容 → load_pinned_context 格式化块。
/// 这是「提示词模板每次注入」的网关半边（连接器半边见 bridge_runtime build_prompt 测试）。
#[sqlx::test]
async fn m2_pinned_context_from_workbench_config(db: PgPool) {
    use server::gateway::dispatcher::load_pinned_context;
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let bot = seed_bot(&db).await;
    add_member(&db, ch, bot, "bot").await;
    let who = Principal::bot(bot);
    let cid = ch.to_string();

    // 写提示词文件 + .workbench.json 的 pin 列表（走真实 fs.* 路径）
    let _ = dispatch(
        &db,
        who,
        &req("fs.write", serde_json::json!({ "channel_id": cid, "path": "prompts/sys.md", "content": "Always end with ZEBRA.", "if_version": 0 })),
    )
    .await;
    let _ = dispatch(
        &db,
        who,
        &req("fs.write", serde_json::json!({ "channel_id": cid, "path": ".workbench.json", "content": "{\"pinned\":[\"prompts/sys.md\"]}", "if_version": 0 })),
    )
    .await;

    let pinned = load_pinned_context(&db, ch).await;
    assert_eq!(pinned.len(), 1, "应载入 1 个 pin 块: {pinned:?}");
    assert!(
        pinned[0].contains("prompts/sys.md"),
        "块应标注路径: {pinned:?}"
    );
    assert!(
        pinned[0].contains("Always end with ZEBRA."),
        "块应含文件内容: {pinned:?}"
    );
}

/// 未知 verb → UNKNOWN_RESOURCE（dispatch fallback 行为锁定）。
#[sqlx::test]
async fn m2_dispatch_unknown_resource(db: PgPool) {
    let r = dispatch(
        &db,
        Principal::bot(Uuid::new_v4()),
        &req("fs.teleport", serde_json::json!({})),
    )
    .await;
    assert_eq!(r["ok"], false);
    assert_eq!(
        r["code"], "UNKNOWN_RESOURCE",
        "未知 verb 应 UNKNOWN_RESOURCE: {r}"
    );
}

// ── M2 Slice 1：user→dispatch 桥（dispatch_user）的鉴权契约 ────────────────────
//
// 浏览器 WS 经 `resource_req` → `dispatch_user(Principal::user)`。在通用 dispatch
// 的 channel-role 鉴权之上，破坏性 `fs.rm`/`fs.mv` 收紧到 owner/admin（评审：
// 普通 member 不应能一帧 `rm -r` 掉整个工作区，含 agent 记忆）。bot 路径不受此限。

/// member 可读写，但破坏性 `fs.rm` 被拒（PERMISSION_DENIED）。
#[sqlx::test]
async fn m2_user_member_can_write_but_not_rm(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let user = seed_user(&db).await;
    add_member(&db, ch, user, "user").await; // role = member
    let cid = ch.to_string();

    let r = dispatch_user(
        &db,
        user,
        &req("fs.write", serde_json::json!({ "channel_id": cid, "path": "a.md", "content": "hi", "if_version": 0 })),
    )
    .await;
    assert_eq!(r["ok"], true, "member 经 user 桥应可写: {r}");

    let r = dispatch_user(
        &db,
        user,
        &req(
            "fs.rm",
            serde_json::json!({ "channel_id": cid, "path": "a.md" }),
        ),
    )
    .await;
    assert_eq!(r["ok"], false);
    assert_eq!(
        r["code"], "PERMISSION_DENIED",
        "member 破坏性 rm 应被拒: {r}"
    );
}

/// owner/admin 可执行破坏性 `fs.rm`。
#[sqlx::test]
async fn m2_user_admin_can_rm(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let admin = seed_user(&db).await;
    add_member_role(&db, ch, admin, "user", "admin").await;
    let cid = ch.to_string();

    let _ = dispatch_user(
        &db,
        admin,
        &req("fs.write", serde_json::json!({ "channel_id": cid, "path": "a.md", "content": "hi", "if_version": 0 })),
    )
    .await;
    let r = dispatch_user(
        &db,
        admin,
        &req(
            "fs.rm",
            serde_json::json!({ "channel_id": cid, "path": "a.md" }),
        ),
    )
    .await;
    assert_eq!(r["ok"], true, "admin 应可 rm: {r}");
}

/// 非频道成员经 user 桥读 → NOT_MEMBER（与 bot 路径一致，channel-role 唯一事实源）。
#[sqlx::test]
async fn m2_user_non_member_rejected(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let outsider = seed_user(&db).await; // 故意不 add_member
    let r = dispatch_user(
        &db,
        outsider,
        &req(
            "fs.read",
            serde_json::json!({ "channel_id": ch.to_string(), "path": "x.md" }),
        ),
    )
    .await;
    assert_eq!(r["ok"], false);
    assert_eq!(
        r["code"], "NOT_MEMBER",
        "非成员经 user 桥应 NOT_MEMBER: {r}"
    );
}

// ── M2 Slice 2：fs.* 写入安全上限（DoS 防护）─────────────────────────────────
//
// user 桥让浏览器能写 context_files（TEXT 入库 + 全量 WS 广播）。单文件硬上限
// 256KB，超限回 CONTENT_TOO_LARGE；对 bot 与 user 路径同等生效（安全上限，非授权）。

/// 超 256KB 的写入被拒；append 把已有文件推过上限也被拒（覆盖 update_content 路径）；
/// 正常小写入通过。
#[sqlx::test]
async fn m2_fs_write_size_cap(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let bot = seed_bot(&db).await;
    add_member(&db, ch, bot, "bot").await;
    let who = Principal::bot(bot);
    let cid = ch.to_string();

    // 直接写超限内容 → CONTENT_TOO_LARGE
    let huge = "x".repeat(256 * 1024 + 1);
    let r = dispatch(
        &db,
        who,
        &req("fs.write", serde_json::json!({ "channel_id": cid, "path": "big.bin", "content": huge, "if_version": 0 })),
    )
    .await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "CONTENT_TOO_LARGE", "超限写入应被拒: {r}");

    // 接近上限的文件 + append 推过上限 → 也被拒（enforce_file_size 在 update_content）
    let near = "y".repeat(256 * 1024 - 10);
    let r = dispatch(
        &db,
        who,
        &req("fs.write", serde_json::json!({ "channel_id": cid, "path": "grow.md", "content": near, "if_version": 0 })),
    )
    .await;
    assert_eq!(r["ok"], true, "接近上限的写入应通过: {r}");
    let r = dispatch(
        &db,
        who,
        &req("fs.append", serde_json::json!({ "channel_id": cid, "path": "grow.md", "content": "zzzzzzzzzzzzzzzzzzzz" })),
    )
    .await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "CONTENT_TOO_LARGE", "append 推过上限应被拒: {r}");

    // 正常小写入仍通过
    let r = dispatch(
        &db,
        who,
        &req("fs.write", serde_json::json!({ "channel_id": cid, "path": "ok.md", "content": "small", "if_version": 0 })),
    )
    .await;
    assert_eq!(r["ok"], true, "正常写入应通过: {r}");
}

// M2 工作台扩展两类拆分：全局模板（DATA，无 bundle、无沙箱）的 put/list/delete 往返。
// 模板是全局共享的（不按用户/频道作用域），upsert 幂等，删除返回受影响行数。
#[sqlx::test]
async fn m2_global_template_store_roundtrip(db: PgPool) {
    let manifest = r#"{"id":"research","title":"科研","views":[]}"#;

    // install → list 能看到，manifest 解析回 JSON
    workbench_templates::put(&db, "research", "科研", manifest, "admin-uid")
        .await
        .unwrap();
    let rows = workbench_templates::list(&db).await.unwrap();
    assert_eq!(rows.len(), 1, "应有一个全局模板: {rows:?}");
    assert_eq!(rows[0]["tpl_id"], "research");
    assert_eq!(rows[0]["title"], "科研");
    assert_eq!(
        rows[0]["manifest"]["id"], "research",
        "manifest 应解析回对象"
    );

    // upsert：同 id 再 put 不新增、只更新标题
    workbench_templates::put(&db, "research", "科研v2", manifest, "admin-uid")
        .await
        .unwrap();
    let rows = workbench_templates::list(&db).await.unwrap();
    assert_eq!(rows.len(), 1, "upsert 不应新增行");
    assert_eq!(rows[0]["title"], "科研v2", "标题应被更新");

    // delete：受影响 1 行；再删 0 行
    assert_eq!(
        workbench_templates::delete(&db, "research").await.unwrap(),
        1
    );
    assert_eq!(
        workbench_templates::delete(&db, "research").await.unwrap(),
        0
    );
    assert!(workbench_templates::list(&db).await.unwrap().is_empty());
}

// 会话/工作区模型(2026-06-24):personal workspace 惰性创建,每用户至多一个(偏唯一索引)。
#[sqlx::test]
async fn personal_workspace_get_or_create_is_idempotent(db: PgPool) {
    let user = seed_user(&db).await;

    let ws1 = workspaces::get_or_create_personal_workspace(&db, user)
        .await
        .unwrap();
    let ws2 = workspaces::get_or_create_personal_workspace(&db, user)
        .await
        .unwrap();
    assert_eq!(ws1, ws2, "同一用户的 personal workspace 必须复用,不新建");

    // kind/owner 正确,且全库该用户只有一个 personal ws
    let row = sqlx::query("SELECT kind, owner_user_id FROM workspaces WHERE workspace_id = $1")
        .bind(ws1.to_string())
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("kind"), "personal");
    assert_eq!(
        row.get::<Option<String>, _>("owner_user_id"),
        Some(user.to_string())
    );

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workspaces WHERE owner_user_id = $1 AND kind = 'personal'",
    )
    .bind(user.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(count, 1, "每用户至多一个 personal workspace");

    // 不同用户各自独立
    let other = seed_user(&db).await;
    let ws_other = workspaces::get_or_create_personal_workspace(&db, other)
        .await
        .unwrap();
    assert_ne!(ws1, ws_other);
}

// DM = type='dm' channel,按成员对去重、与发起方无关、两人成员、锚在发起方 personal ws。
#[sqlx::test]
async fn dm_find_or_create_dedups_by_pair(db: PgPool) {
    let a = seed_user(&db).await;
    let b = seed_user(&db).await;

    let dm1 = dms::find_or_create_dm(&db, a, &b.to_string(), false)
        .await
        .unwrap();
    let dm2 = dms::find_or_create_dm(&db, a, &b.to_string(), false)
        .await
        .unwrap();
    assert_eq!(dm1, dm2, "同一对再建必复用");

    // 对称:b 发起与 a 的 DM,应是同一个(canonical key 与发起方无关)
    let dm3 = dms::find_or_create_dm(&db, b, &a.to_string(), false)
        .await
        .unwrap();
    assert_eq!(dm1, dm3, "DM 按成员对去重,不分发起方");

    // type='dm' + 恰好两人成员
    let typ: String = sqlx::query_scalar("SELECT type FROM channels WHERE channel_id = $1")
        .bind(dm1.to_string())
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(typ, "dm");
    let members: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM channel_memberships WHERE channel_id = $1")
            .bind(dm1.to_string())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(members, 2);

    // 锚在发起方(a)的 personal workspace
    let kind: String = sqlx::query_scalar(
        "SELECT w.kind FROM channels c JOIN workspaces w ON w.workspace_id = c.workspace_id WHERE c.channel_id = $1",
    )
    .bind(dm1.to_string()).fetch_one(&db).await.unwrap();
    assert_eq!(kind, "personal");

    // 不能跟自己 DM
    assert!(dms::find_or_create_dm(&db, a, &a.to_string(), false)
        .await
        .is_err());
}

// M3 inbox_open(channel.files.read):按 channel_id 限定作用域(修了「永 404」+ 防跨频道猜读),
// 图片等二进制返回 kind:"binary" 不伪装文本(S3 未初始化时走该分支,无需对象存储)。
#[sqlx::test]
async fn m3_channel_files_read_scoped_and_binary(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let other = seed_channel(&db, ws).await;
    let user = seed_user(&db).await;
    add_member(&db, ch, user, "user").await;
    add_member(&db, other, user, "user").await;

    let fid = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO file_records
            (file_id, channel_id, uploader_id, original_path, original_filename, content_type, object_key, status)
         VALUES ($1, $2, $3, 'pic.png', 'pic.png', 'image/png', 'k/pic.png', 'uploaded')",
    )
    .bind(&fid)
    .bind(ch.to_string())
    .bind(user.to_string())
    .execute(&db)
    .await
    .unwrap();

    let principal = Principal::user(user);

    // 正确频道 → 找得到(不再 404),content 为 null。注意:测试环境没 init_s3,
    // 所以会先命中「对象存储不可用」分支 → kind:"unavailable";text/binary 分类需真实
    // 对象存储才能走到,由 files.rs 的 is_text 单测覆盖。这里锁定的是「频道作用域 +
    // status/expiry 闸门」,以及二进制/无存储时绝不返回伪造文本。
    let r = files::handle_read(
        &db,
        &principal,
        &serde_json::json!({ "channel_id": ch, "file_id": fid }),
    )
    .await
    .expect("应能读到该频道的文件");
    assert_eq!(r["content"], serde_json::Value::Null, "不应返回文本: {r}");
    assert_eq!(r["kind"], "unavailable");
    assert_eq!(r["file_id"], fid);

    // 错误频道 → not_found(作用域/安全:不能凭 file_id 猜读别的频道)
    let r2 = files::handle_read(
        &db,
        &principal,
        &serde_json::json!({ "channel_id": other, "file_id": fid }),
    )
    .await;
    assert!(r2.is_err(), "跨频道读应被拒");

    // status 非终态(pending)→ not_found:和 REST 下载、inbox_list 口径一致,不能读未确认的字节
    let pending = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO file_records
            (file_id, channel_id, uploader_id, original_path, original_filename, content_type, object_key, status)
         VALUES ($1, $2, $3, 'p.txt', 'p.txt', 'text/plain', 'k/p.txt', 'pending')",
    )
    .bind(&pending).bind(ch.to_string()).bind(user.to_string())
    .execute(&db).await.unwrap();
    let rp = files::handle_read(
        &db,
        &principal,
        &serde_json::json!({ "channel_id": ch, "file_id": pending }),
    )
    .await;
    assert!(rp.is_err(), "未上传完成(pending)的文件不应可读");

    // 已过期(expires_at 过去)→ not_found:agent 这道门不能绕过保留策略读到过期文件
    let expired = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO file_records
            (file_id, channel_id, uploader_id, original_path, original_filename, content_type, object_key, status, expires_at)
         VALUES ($1, $2, $3, 'e.txt', 'e.txt', 'text/plain', 'k/e.txt', 'uploaded', NOW() - INTERVAL '1 day')",
    )
    .bind(&expired).bind(ch.to_string()).bind(user.to_string())
    .execute(&db).await.unwrap();
    let re = files::handle_read(
        &db,
        &principal,
        &serde_json::json!({ "channel_id": ch, "file_id": expired }),
    )
    .await;
    assert!(re.is_err(), "过期文件不应可读");
}

// M3 Plan A: inbox_stage (channel.files.stage) + inbox_realize (channel.files.realize).
// stage 不需要 S3——只写 DB 记录。realize 校验 status=staged 且同一 bot，然后尝试 S3
// (无 init_s3 → E_STORAGE_UNAVAILABLE)。
#[sqlx::test]
async fn m3_inbox_stage_and_realize_lifecycle(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let bot = seed_bot(&db).await;
    add_member(&db, ch, bot, "bot").await;
    let outsider_bot = seed_bot(&db).await;
    add_member(&db, ch, outsider_bot, "bot").await;

    let p = server::resource::Principal::bot(bot);
    let cid = ch.to_string();

    // 非成员 bot → 鉴权失败
    let stranger = server::resource::Principal::bot(Uuid::new_v4());
    let denied = files::handle_stage(
        &db,
        &stranger,
        &serde_json::json!({
            "channel_id": cid, "filename": "r.pdf", "remote_ref": "/tmp/r.pdf"
        }),
    )
    .await;
    assert!(denied.is_err(), "非成员 bot 不能 stage");

    // 合法 stage：不需要 S3，直接成功
    let res = files::handle_stage(
        &db,
        &p,
        &serde_json::json!({
            "channel_id": cid,
            "filename": "report.pdf",
            "remote_ref": "/home/user/report.pdf",
            "content_type": "application/pdf"
        }),
    )
    .await
    .expect("stage should succeed without S3");
    let file_id = res["file_id"].as_str().expect("file_id").to_string();
    assert_eq!(res["status"], "staged");

    // realize by wrong bot → FORBIDDEN
    let pout = server::resource::Principal::bot(outsider_bot);
    let bad = files::handle_realize(
        &db,
        &pout,
        &serde_json::json!({
            "file_id": file_id,
            "channel_id": cid,
            "data_b64": "aGVsbG8=",
            "content_type": "application/pdf",
            "filename": "report.pdf"
        }),
    )
    .await;
    assert_eq!(bad.unwrap_err().0, "FORBIDDEN", "other bot cannot realize");

    // realize by correct bot, no S3 → E_STORAGE_UNAVAILABLE (not a fake success)
    let no_store = files::handle_realize(
        &db,
        &p,
        &serde_json::json!({
            "file_id": file_id,
            "channel_id": cid,
            "data_b64": "aGVsbG8=",
            "content_type": "application/pdf",
            "filename": "report.pdf"
        }),
    )
    .await;
    assert_eq!(
        no_store.unwrap_err().0,
        "E_STORAGE_UNAVAILABLE",
        "realize must not fake success without S3"
    );

    // double-realize (status is still staged because realize failed) → ok to retry;
    // but if status had been flipped to uploaded, second realize should fail with INVALID_STATE.
    // Since S3 is absent the status stays 'staged', so a re-attempt still hits E_STORAGE_UNAVAILABLE.
    let retry = files::handle_realize(
        &db,
        &p,
        &serde_json::json!({
            "file_id": file_id,
            "channel_id": cid,
            "data_b64": "aGVsbG8=",
            "content_type": "application/pdf",
            "filename": "report.pdf"
        }),
    )
    .await;
    assert_eq!(retry.unwrap_err().0, "E_STORAGE_UNAVAILABLE");
}

// M3 inbox_deliver(channel.files.create):校验 + 鉴权,且绝不再伪造 file_id。
// 真正的 S3 往返需要 init_s3(测试环境没有),所以这里锁定的是「坏输入早失败」「无存储时
// 显式报错而非假成功」——后者正是评审里那条 HIGH(撒谎 stub)的回归护栏。
#[sqlx::test]
async fn m3_inbox_deliver_validates_and_requires_storage(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let writer = seed_user(&db).await;
    add_member(&db, ch, writer, "user").await; // role 'member' → 可写
    let outsider = seed_user(&db).await;

    let p = Principal::user(writer);

    // 非成员 → 鉴权失败(不是 storage 错误)
    let po = Principal::user(outsider);
    let denied = files::handle_create(
        &db,
        &po,
        &serde_json::json!({
            "channel_id": ch, "filename": "r.txt", "data_b64": "aGVsbG8="
        }),
    )
    .await;
    assert!(denied.is_err(), "非成员不能投递");

    // 非法 base64 → INVALID_PARAMS(在落地到存储之前就拒)
    let bad = files::handle_create(
        &db,
        &p,
        &serde_json::json!({
            "channel_id": ch, "filename": "r.txt", "data_b64": "!!! not base64 !!!"
        }),
    )
    .await;
    assert_eq!(bad.unwrap_err().0, "INVALID_PARAMS");

    // 合法 base64,但测试无 init_s3 → 显式 E_STORAGE_UNAVAILABLE,绝不返回伪造的 file_id
    let nostore = files::handle_create(
        &db,
        &p,
        &serde_json::json!({
            "channel_id": ch, "filename": "r.txt", "data_b64": "aGVsbG8=" // "hello"
        }),
    )
    .await;
    assert_eq!(nostore.unwrap_err().0, "E_STORAGE_UNAVAILABLE");
}

// ── Phase A：promoted session/update artifacts（plan / usage / commands）─────────
//
// 验证 domain::{plan_store,usage_store,commands_store}::record（写）→ resource verb
// handle_read（读）整链在真实 Postgres 上的行为（M2 门：每个功能一条集成测试）。
// 重点钉死 usage 的 SUM::bigint：Postgres SUM(bigint) 返回 NUMERIC，若不 cast 回
// bigint，sqlx 无 i64 Decode → 静默解码失败被吞成 null（token 总计永远显示 —）。
use server::domain::acp_session_updates::{
    AvailableCommand, AvailableCommands, Plan, PlanEntry, Usage,
};
use server::domain::{commands_store, plan_store, usage_store};

#[sqlx::test]
async fn phasea_usage_read_sums_tokens_as_i64(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let bot = seed_bot(&db).await;
    add_member(&db, ch, bot, "bot").await;
    let cid = ch.to_string();
    let bid = bot.to_string();

    usage_store::record(
        &db,
        Some(&cid),
        &bid,
        Some("s1"),
        &Usage {
            input_tokens: Some(100),
            output_tokens: Some(40),
            total_tokens: Some(140),
            context_window: Some(200_000),
            cost_usd: Some(0.5),
        },
    )
    .await;
    usage_store::record(
        &db,
        Some(&cid),
        &bid,
        Some("s1"),
        &Usage {
            input_tokens: Some(200),
            output_tokens: Some(60),
            total_tokens: Some(260),
            context_window: Some(190_000),
            cost_usd: Some(1.0),
        },
    )
    .await;

    let r = dispatch(
        &db,
        Principal::bot(bot),
        &req(
            "channel.usage.read",
            serde_json::json!({ "channel_id": cid }),
        ),
    )
    .await;
    assert_eq!(r["ok"], true, "usage.read 应成功: {r}");
    let bots = r["data"]["bots"].as_array().unwrap();
    assert_eq!(bots.len(), 1, "一个 bot 一行");
    let b = &bots[0];
    assert_eq!(b["bot_id"].as_str(), Some(bid.as_str()));
    // 关键回归：SUM 必须解码为 i64（非 null）。修复前（无 ::bigint）这里全是 null。
    assert_eq!(
        b["input_tokens"].as_i64(),
        Some(300),
        "input SUM 必须是 i64 300: {b}"
    );
    assert_eq!(b["output_tokens"].as_i64(), Some(100));
    assert_eq!(b["total_tokens"].as_i64(), Some(400));
    // cost_usd 是同一 session 的累计快照 → 聚合取 MAX 而非 SUM（见 resource/usage.rs）。
    assert_eq!(b["cost_usd"].as_f64(), Some(1.0));
    let cw = b["context_window"].as_i64().expect("context_window 非空");
    assert!(
        cw == 200_000 || cw == 190_000,
        "context_window = 最新一行: {cw}"
    );

    // Session scope: a 2nd session's usage must NOT bleed into a per-session read.
    usage_store::record(
        &db,
        Some(&cid),
        &bid,
        Some("s2"),
        &Usage {
            input_tokens: Some(1000),
            output_tokens: None,
            total_tokens: Some(1000),
            context_window: Some(50_000),
            cost_usd: Some(9.0),
        },
    )
    .await;
    let s1 = dispatch(
        &db,
        Principal::bot(bot),
        &req(
            "channel.usage.read",
            serde_json::json!({ "channel_id": cid, "session_id": "s1" }),
        ),
    )
    .await;
    let b1 = &s1["data"]["bots"].as_array().unwrap()[0];
    assert_eq!(
        b1["input_tokens"].as_i64(),
        Some(300),
        "session=s1 只累计 s1 的两条快照"
    );
    // 同 session 的 cost 累计快照取 MAX。
    assert_eq!(b1["cost_usd"].as_f64(), Some(1.0));
    let s2 = dispatch(
        &db,
        Principal::bot(bot),
        &req(
            "channel.usage.read",
            serde_json::json!({ "channel_id": cid, "session_id": "s2" }),
        ),
    )
    .await;
    let b2 = &s2["data"]["bots"].as_array().unwrap()[0];
    assert_eq!(b2["input_tokens"].as_i64(), Some(1000));
    assert_eq!(b2["cost_usd"].as_f64(), Some(9.0));
}

#[sqlx::test]
async fn phasea_usage_read_requires_membership(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let outsider = seed_bot(&db).await; // 不加入频道
    let r = dispatch(
        &db,
        Principal::bot(outsider),
        &req(
            "channel.usage.read",
            serde_json::json!({ "channel_id": ch.to_string() }),
        ),
    )
    .await;
    assert_eq!(r["ok"], false, "非成员应被拒: {r}");
    assert_eq!(r["code"].as_str(), Some("NOT_MEMBER"));
}

#[sqlx::test]
async fn phasea_plan_read_returns_progress_and_upserts(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let bot = seed_bot(&db).await;
    add_member(&db, ch, bot, "bot").await;
    let cid = ch.to_string();
    let bid = bot.to_string();

    plan_store::record(
        &db,
        Some(&cid),
        &bid,
        Some("sess-1"),
        &Plan {
            entries: vec![
                PlanEntry {
                    content: "read".into(),
                    priority: None,
                    status: Some("completed".into()),
                },
                PlanEntry {
                    content: "write".into(),
                    priority: Some("high".into()),
                    status: Some("pending".into()),
                },
            ],
        },
    )
    .await;
    // 再次 record 同 (channel,bot,session) → latest-wins，仍一行、进度更新。
    plan_store::record(
        &db,
        Some(&cid),
        &bid,
        Some("sess-1"),
        &Plan {
            entries: vec![
                PlanEntry {
                    content: "read".into(),
                    priority: None,
                    status: Some("completed".into()),
                },
                PlanEntry {
                    content: "write".into(),
                    priority: None,
                    status: Some("completed".into()),
                },
                PlanEntry {
                    content: "test".into(),
                    priority: None,
                    status: Some("pending".into()),
                },
            ],
        },
    )
    .await;

    let r = dispatch(
        &db,
        Principal::bot(bot),
        &req(
            "channel.plan.read",
            serde_json::json!({ "channel_id": cid }),
        ),
    )
    .await;
    assert_eq!(r["ok"], true, "plan.read 应成功: {r}");
    let plans = r["data"]["plans"].as_array().unwrap();
    assert_eq!(plans.len(), 1, "upsert 应只有一行");
    let p = &plans[0];
    assert_eq!(p["session_id"].as_str(), Some("sess-1"));
    assert_eq!(p["total"].as_i64(), Some(3));
    assert_eq!(p["completed"].as_i64(), Some(2));
    assert_eq!(p["entries"].as_array().unwrap().len(), 3);

    // Session scope (ViewBoard follows the selected session): a 2nd session, then filter.
    plan_store::record(
        &db,
        Some(&cid),
        &bid,
        Some("sess-2"),
        &Plan {
            entries: vec![PlanEntry {
                content: "other".into(),
                priority: None,
                status: Some("pending".into()),
            }],
        },
    )
    .await;
    let all = dispatch(
        &db,
        Principal::bot(bot),
        &req(
            "channel.plan.read",
            serde_json::json!({ "channel_id": cid }),
        ),
    )
    .await;
    assert_eq!(
        all["data"]["plans"].as_array().unwrap().len(),
        2,
        "无 session_id 返回两会话"
    );
    let one = dispatch(
        &db,
        Principal::bot(bot),
        &req(
            "channel.plan.read",
            serde_json::json!({ "channel_id": cid, "session_id": "sess-2" }),
        ),
    )
    .await;
    let scoped = one["data"]["plans"].as_array().unwrap();
    assert_eq!(scoped.len(), 1, "session_id=sess-2 只返回该会话");
    assert_eq!(scoped[0]["session_id"].as_str(), Some("sess-2"));
}

#[sqlx::test]
async fn phasea_commands_read_projects_name_and_description(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let bot = seed_bot(&db).await;
    add_member(&db, ch, bot, "bot").await;
    let cid = ch.to_string();

    commands_store::record(
        &db,
        Some(&cid),
        &bot.to_string(),
        None,
        &AvailableCommands {
            commands: vec![
                AvailableCommand {
                    name: "review".into(),
                    description: Some("Review the diff".into()),
                    input: None,
                },
                AvailableCommand {
                    name: "test".into(),
                    description: None,
                    input: None,
                },
            ],
        },
    )
    .await;

    let r = dispatch(
        &db,
        Principal::bot(bot),
        &req(
            "channel.commands.read",
            serde_json::json!({ "channel_id": cid }),
        ),
    )
    .await;
    assert_eq!(r["ok"], true, "commands.read 应成功: {r}");
    let bots = r["data"]["bots"].as_array().unwrap();
    assert_eq!(bots.len(), 1);
    let cmds = bots[0]["commands"].as_array().unwrap();
    assert_eq!(cmds.len(), 2);
    assert_eq!(cmds[0]["name"].as_str(), Some("review"));
    assert_eq!(cmds[0]["description"].as_str(), Some("Review the diff"));
    assert_eq!(cmds[1]["name"].as_str(), Some("test"));
}

#[sqlx::test]
async fn phasea_sessions_read_lists_channel_sessions(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let bot = seed_bot(&db).await;
    add_member(&db, ch, bot, "bot").await;
    let cid = ch.to_string();

    // Create an "other" session bound to the channel (status = idle).
    let handle =
        server::domain::sessions::create_channel_session(&db, bot, "acct1", &cid, "other", None, &[])
            .await
            .expect("create channel session");

    let r = dispatch(
        &db,
        Principal::bot(bot),
        &req(
            "channel.sessions.read",
            serde_json::json!({ "channel_id": cid }),
        ),
    )
    .await;
    assert_eq!(r["ok"], true, "sessions.read 应成功: {r}");
    let sessions = r["data"]["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1, "应列出该频道的一个会话");
    let s = &sessions[0];
    assert_eq!(
        s["session_id"].as_str(),
        Some(handle.session_id.to_string().as_str())
    );
    assert_eq!(s["bot_id"].as_str(), Some(bot.to_string().as_str()));
    assert_eq!(s["role"].as_str(), Some("other"));
    assert_eq!(s["is_primary"].as_bool(), Some(false));
    assert_eq!(s["status"].as_str(), Some("idle"));
    // 会话卡片字段：bot_name（display_name→username 回落）+ created_at。
    assert!(
        s["bot_name"].as_str().is_some_and(|n| n.starts_with("b-")),
        "bot_name 应回落到 username: {s}"
    );
    assert!(
        s["created_at"].as_str().is_some_and(|t| !t.is_empty()),
        "created_at 应为 RFC3339 时间: {s}"
    );

    // Non-members can't read it.
    let outsider = seed_bot(&db).await;
    let denied = dispatch(
        &db,
        Principal::bot(outsider),
        &req(
            "channel.sessions.read",
            serde_json::json!({ "channel_id": cid }),
        ),
    )
    .await;
    assert_eq!(denied["ok"], false);
    assert_eq!(denied["code"].as_str(), Some("NOT_MEMBER"));
}

#[sqlx::test]
async fn phasea_activity_read_desc_returns_latest_first(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let user = seed_user(&db).await;
    add_member(&db, ch, user, "user").await;
    let fanout = fanout();
    let registry = StreamRegistry::new();
    let bot_locator: Arc<dyn BotLocator> = InProcessBotLocator::new();
    for i in 0..3 {
        messages::create_message(
            &db,
            &fanout,
            &registry,
            &bot_locator,
            CreateMessageParams {
                user_id: user,
                channel_id: ch,
                content: format!("m{i}"),
                msg_type: None,
                reply_to_msg_id: None,
                file_ids: vec![],
                mention_ids: vec![],
                session_id: None,
            },
        )
        .await
        .unwrap();
    }
    let cid = ch.to_string();

    // desc=true → newest-first (the Activity board feed): seq 3,2,1.
    let r = dispatch(
        &db,
        Principal::user(user),
        &req(
            "channel.activity.read",
            serde_json::json!({ "channel_id": cid, "desc": true }),
        ),
    )
    .await;
    assert_eq!(r["ok"], true, "activity.read 应成功: {r}");
    let seqs: Vec<i64> = r["data"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["channel_seq"].as_i64())
        .collect();
    assert_eq!(seqs, vec![3, 2, 1], "desc 最新在前");

    // default (asc) preserves the bot's forward-cursor read: seq 1,2,3.
    let r2 = dispatch(
        &db,
        Principal::user(user),
        &req(
            "channel.activity.read",
            serde_json::json!({ "channel_id": cid }),
        ),
    )
    .await;
    let seqs2: Vec<i64> = r2["data"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["channel_seq"].as_i64())
        .collect();
    assert_eq!(seqs2, vec![1, 2, 3], "默认 asc 最旧在前");
}

// ── channel.messages.search：ILIKE 子串搜索经 dispatch ────────────────────────

/// 搜索消息：大小写不敏感子串命中、通配符按字面转义、before 翻页、
/// 非成员拒绝、空 query 报 INVALID_PARAMS。
#[sqlx::test]
async fn messages_search_matches_escapes_and_paginates(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let user = seed_user(&db).await;
    add_member(&db, ch, user, "user").await;
    let bot = seed_bot(&db).await;
    add_member(&db, ch, bot, "bot").await;

    let fanout = fanout();
    let registry = StreamRegistry::new();
    let bot_locator: Arc<dyn BotLocator> = InProcessBotLocator::new();
    for content in [
        "Deploy went fine",
        "50% off",
        "In 2024 we shipped",
        "deploy FAILED at step 3",
        "another DEPLOY note",
    ] {
        messages::create_message(
            &db,
            &fanout,
            &registry,
            &bot_locator,
            CreateMessageParams {
                user_id: user,
                channel_id: ch,
                content: content.to_string(),
                msg_type: None,
                reply_to_msg_id: None,
                file_ids: vec![],
                mention_ids: vec![],
                session_id: None,
            },
        )
        .await
        .unwrap();
    }
    let who = Principal::bot(bot);
    let cid = ch.to_string();

    // 大小写不敏感：三条 deploy 全中，页内按时间升序。
    let r = dispatch(
        &db,
        who,
        &req(
            "channel.messages.search",
            serde_json::json!({ "channel_id": cid, "query": "deploy" }),
        ),
    )
    .await;
    assert_eq!(r["ok"], true, "search 应成功: {r}");
    let contents: Vec<&str> = r["data"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["content"].as_str())
        .collect();
    assert_eq!(
        contents,
        vec![
            "Deploy went fine",
            "deploy FAILED at step 3",
            "another DEPLOY note"
        ],
        "deploy 应命中三条且升序"
    );
    assert_eq!(r["data"]["meta"]["has_more_before"], false);

    // 通配符转义：query "0%" 只按字面命中 "50% off"，不把 % 当通配符
    // （未转义时 %0%% 会连 "In 2024 we shipped" 一起命中）。
    let r = dispatch(
        &db,
        who,
        &req(
            "channel.messages.search",
            serde_json::json!({ "channel_id": cid, "query": "0%" }),
        ),
    )
    .await;
    let contents: Vec<&str> = r["data"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["content"].as_str())
        .collect();
    assert_eq!(contents, vec!["50% off"], "0% 应按字面只命中 50% off");

    // 翻页：limit=2 返回最新两条命中，has_more_before=true；
    // before=本页最旧命中 → 拿到最早那条。
    let r = dispatch(
        &db,
        who,
        &req(
            "channel.messages.search",
            serde_json::json!({ "channel_id": cid, "query": "deploy", "limit": 2 }),
        ),
    )
    .await;
    let page = r["data"]["messages"].as_array().unwrap();
    assert_eq!(page.len(), 2);
    assert_eq!(page[0]["content"], "deploy FAILED at step 3");
    assert_eq!(page[1]["content"], "another DEPLOY note");
    assert_eq!(r["data"]["meta"]["has_more_before"], true);
    let oldest_id = page[0]["msg_id"].as_str().unwrap();
    let r = dispatch(
        &db,
        who,
        &req(
            "channel.messages.search",
            serde_json::json!({ "channel_id": cid, "query": "deploy", "limit": 2, "before": oldest_id }),
        ),
    )
    .await;
    let contents: Vec<&str> = r["data"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["content"].as_str())
        .collect();
    assert_eq!(contents, vec!["Deploy went fine"], "before 应翻到更早命中");
    assert_eq!(r["data"]["meta"]["has_more_before"], false);

    // 非成员拒绝。
    let outsider = seed_bot(&db).await;
    let r = dispatch(
        &db,
        Principal::bot(outsider),
        &req(
            "channel.messages.search",
            serde_json::json!({ "channel_id": cid, "query": "deploy" }),
        ),
    )
    .await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "NOT_MEMBER");

    // 空 query 报参数错误。
    let r = dispatch(
        &db,
        who,
        &req(
            "channel.messages.search",
            serde_json::json!({ "channel_id": cid, "query": "  " }),
        ),
    )
    .await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "INVALID_PARAMS");
}

// ── bots-as-members：邀请候选搜索 / readonly 不派发 / bot 自退频道 ─────────────

use server::domain::invitable::{search_invitable, InvitableCaller};

/// 带命名/归属的用户与 bot 种子（invitable 搜索需要按名字匹配、按归属过滤）。
async fn seed_named_user(db: &PgPool, username: &str, display: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (user_id, username, password_hash, display_name)
         VALUES ($1, $2, 'x', $3)",
    )
    .bind(id.to_string())
    .bind(format!("{username}-{id}"))
    .bind(display)
    .execute(db)
    .await
    .unwrap();
    id
}

async fn seed_named_bot(db: &PgPool, username: &str, display: &str, owner: Option<Uuid>) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO bot_accounts (bot_id, username, display_name, created_by)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(id.to_string())
    .bind(format!("{username}-{id}"))
    .bind(display)
    .bind(owner.map(|o| o.to_string()))
    .execute(db)
    .await
    .unwrap();
    id
}

/// invitable 搜索的可见范围：
/// - 用户候选 = 频道 workspace 的 active 成员 ∪ 调用者已通过好友；无关用户不可见。
/// - bot 候选 = 调用者 own 的 ∪ 有 session_create INITIATE 授权的；他人 bot、禁用 bot 不可见。
/// - 已在频道内的候选带 already_member 标记。
#[sqlx::test]
async fn invitable_search_scopes_users_and_bots(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let caller = seed_user(&db).await;
    add_member_role(&db, ch, caller, "user", "owner").await;

    // 用户候选：workspace 成员 wanda；好友 fred；无关 randy。
    let wanda = seed_named_user(&db, "wanda", "Wanda Findable").await;
    sqlx::query("INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')")
        .bind(ws.to_string())
        .bind(wanda.to_string())
        .execute(&db)
        .await
        .unwrap();
    let fred = seed_named_user(&db, "fred", "Fred Findable").await;
    let (a, b) = if caller.to_string() <= fred.to_string() {
        (caller, fred)
    } else {
        (fred, caller)
    };
    sqlx::query(
        "INSERT INTO friendships (friendship_id, user_id, friend_id, pair_key, status)
         VALUES ($1, $2, $3, $4, 'accepted')",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(caller.to_string())
    .bind(fred.to_string())
    .bind(format!("{a}:{b}"))
    .execute(&db)
    .await
    .unwrap();
    let _randy = seed_named_user(&db, "randy", "Randy Findable").await;

    // bot 候选：own 的 alpha；他人的 beta（无授权）；他人的 gamma（有 session_create 授权）；
    // own 但禁用的 delta。
    let other = seed_user(&db).await;
    let alpha = seed_named_bot(&db, "alpha", "Findable Alpha", Some(caller)).await;
    let _beta = seed_named_bot(&db, "beta", "Findable Beta", Some(other)).await;
    let gamma = seed_named_bot(&db, "gamma", "Findable Gamma", Some(other)).await;
    sqlx::query(
        "INSERT INTO bot_event_access (bot_id, channel_id, subject_kind, subject_id, event_class, capability, decision)
         VALUES ($1, $2, 'user', $3, 'session_create', 'initiate', 'allow')",
    )
    .bind(gamma.to_string())
    .bind(ch.to_string())
    .bind(caller.to_string())
    .execute(&db)
    .await
    .unwrap();
    let delta = seed_named_bot(&db, "delta", "Findable Delta", Some(caller)).await;
    sqlx::query("UPDATE bot_accounts SET is_disabled = TRUE WHERE bot_id = $1")
        .bind(delta.to_string())
        .execute(&db)
        .await
        .unwrap();
    // alpha 已在频道内 → already_member。
    add_member(&db, ch, alpha, "bot").await;

    let locator: Arc<dyn BotLocator> = InProcessBotLocator::new();
    let who = InvitableCaller {
        user_id: &caller.to_string(),
        global_role: "member",
        channel_role: "owner",
    };
    let items = search_invitable(&db, &locator, &who, &ch.to_string(), "Findable")
        .await
        .unwrap();

    let ids: Vec<&str> = items.iter().map(|i| i.member_id.as_str()).collect();
    assert!(ids.contains(&wanda.to_string().as_str()), "workspace 成员应可见");
    assert!(ids.contains(&fred.to_string().as_str()), "好友应可见");
    assert!(
        !items.iter().any(|i| i.display_name.as_deref() == Some("Randy Findable")),
        "无关用户不可见"
    );
    assert!(ids.contains(&alpha.to_string().as_str()), "own 的 bot 应可见");
    assert!(
        !items.iter().any(|i| i.display_name.as_deref() == Some("Findable Beta")),
        "他人 bot（无授权）不可见"
    );
    assert!(ids.contains(&gamma.to_string().as_str()), "有 session_create 授权的 bot 应可见");
    assert!(
        !items.iter().any(|i| i.display_name.as_deref() == Some("Findable Delta")),
        "禁用 bot 不可见"
    );
    let alpha_item = items.iter().find(|i| i.member_id == alpha.to_string()).unwrap();
    assert!(alpha_item.already_member, "已在频道的 bot 应标 already_member");
    assert_eq!(alpha_item.member_type, "bot");
    assert_eq!(alpha_item.is_online, Some(false), "未连 bridge 的 bot 应离线");
    // 平台管理员对 bot 侧直通。
    let admin_caller = InvitableCaller {
        user_id: &other.to_string(),
        global_role: "admin",
        channel_role: "member",
    };
    let admin_items = search_invitable(&db, &locator, &admin_caller, &ch.to_string(), "Findable")
        .await
        .unwrap();
    assert!(
        admin_items.iter().any(|i| i.member_id == alpha.to_string()),
        "平台管理员应看到所有未禁用 bot"
    );
}

/// readonly 角色的 bot：被 @ 也不派发（消息照常入库）；改回 member 后恢复派发。
#[sqlx::test]
async fn readonly_bot_is_not_dispatched(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let user = seed_user(&db).await;
    add_member(&db, ch, user, "user").await;
    let bot = seed_bot(&db).await;
    add_member_role(&db, ch, bot, "bot", "readonly").await;

    let fanout = fanout();
    let registry = StreamRegistry::new();
    let counter = Arc::new(CountingBotLocator::default());
    let bot_locator: Arc<dyn BotLocator> = counter.clone();

    messages::create_message(
        &db,
        &fanout,
        &registry,
        &bot_locator,
        CreateMessageParams {
            user_id: user,
            channel_id: ch,
            content: "@bot do something".into(),
            msg_type: None,
            reply_to_msg_id: None,
            file_ids: vec![],
            mention_ids: vec![bot],
            session_id: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        counter.dispatched.load(Ordering::SeqCst),
        0,
        "readonly bot 不应被派发"
    );

    sqlx::query(
        "UPDATE channel_memberships SET role = 'member'
         WHERE channel_id = $1 AND member_id = $2 AND member_type = 'bot'",
    )
    .bind(ch.to_string())
    .bind(bot.to_string())
    .execute(&db)
    .await
    .unwrap();

    messages::create_message(
        &db,
        &fanout,
        &registry,
        &bot_locator,
        CreateMessageParams {
            user_id: user,
            channel_id: ch,
            content: "@bot again".into(),
            msg_type: None,
            reply_to_msg_id: None,
            file_ids: vec![],
            mention_ids: vec![bot],
            session_id: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        counter.dispatched.load(Ordering::SeqCst),
        1,
        "member 角色恢复派发"
    );
}

/// bot 自退频道：resource channel.leave 只对 bot principal 开放；DM 拒绝；
/// 退出后 membership 行删除、再退报 NOT_MEMBER。
#[sqlx::test]
async fn bot_leaves_channel_via_resource(db: PgPool) {
    let ws = seed_workspace(&db).await;
    let ch = seed_channel(&db, ws).await;
    let bot = seed_bot(&db).await;
    add_member(&db, ch, bot, "bot").await;
    let user = seed_user(&db).await;
    add_member(&db, ch, user, "user").await;
    let cid = ch.to_string();

    // 用户 principal 不允许走 resource leave（REST 侧才有 last-owner 等守护）。
    let r = dispatch(
        &db,
        Principal::user(user),
        &req("channel.leave", serde_json::json!({ "channel_id": cid })),
    )
    .await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "PERMISSION_DENIED");

    // bot 正常退出。
    let r = dispatch(
        &db,
        Principal::bot(bot),
        &req("channel.leave", serde_json::json!({ "channel_id": cid })),
    )
    .await;
    assert_eq!(r["ok"], true, "bot leave 应成功: {r}");
    let gone: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS(
            SELECT 1 FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2 AND member_type = 'bot'
        )",
    )
    .bind(&cid)
    .bind(bot.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(gone, "membership 行应被删除");

    // 再退 → 已非成员。
    let r = dispatch(
        &db,
        Principal::bot(bot),
        &req("channel.leave", serde_json::json!({ "channel_id": cid })),
    )
    .await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "NOT_MEMBER");

    // DM 不可退出。
    let dm = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels (channel_id, workspace_id, name, type) VALUES ($1, $2, 'dm', 'dm')",
    )
    .bind(dm.to_string())
    .bind(ws.to_string())
    .execute(&db)
    .await
    .unwrap();
    add_member(&db, dm, bot, "bot").await;
    let r = dispatch(
        &db,
        Principal::bot(bot),
        &req("channel.leave", serde_json::json!({ "channel_id": dm.to_string() })),
    )
    .await;
    assert_eq!(r["ok"], false, "DM 不可退出: {r}");
    assert_eq!(r["code"], "INVALID_PARAMS");
}
