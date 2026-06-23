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
use server::domain::messages::{self, CreateMessageParams};
use server::gateway::dispatcher::{self, DispatchParams, DispatchResult};
use server::gateway::realtime::fanout::{Fanout, InProcessFanout};
use server::gateway::registry::{BotLocator, InProcessBotLocator};
use server::gateway::stream::{self, StreamRegistry};

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
    sqlx::query(
        "INSERT INTO channels (channel_id, workspace_id, name) VALUES ($1, $2, 'general')",
    )
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
    assert_eq!(seqs, (1..=N).collect::<Vec<_>>(), "since-seq 应连续返回 1..={N}");

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
        let (db1, f1, r1, l1, p1) = (db.clone(), fanout.clone(), registry.clone(), bot_locator.clone(), make_params());
        let (db2, f2, r2, l2, p2) = (db.clone(), fanout.clone(), registry.clone(), bot_locator.clone(), make_params());
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
    let count: i64 =
        sqlx::query("SELECT COUNT(*) AS c FROM messages WHERE channel_id = $1 AND sender_type = 'bot'")
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

    let row = sqlx::query("SELECT is_partial, channel_seq, content FROM messages WHERE msg_id = $1")
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
        &req("fs.read", serde_json::json!({ "channel_id": cid, "path": "notes/a.md" })),
    )
    .await;
    assert_eq!(r["ok"], true);
    assert_eq!(r["data"]["content"], "hello");

    // ls 子树含该文件
    let r = dispatch(
        &db,
        who,
        &req("fs.ls", serde_json::json!({ "channel_id": cid, "path": "notes" })),
    )
    .await;
    assert_eq!(r["ok"], true);
    let paths: Vec<&str> = r["data"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["path"].as_str())
        .collect();
    assert!(paths.contains(&"notes/a.md"), "ls 应列出 notes/a.md: {paths:?}");

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
        &req("fs.read", serde_json::json!({ "channel_id": cid, "path": "notes/a.md" })),
    )
    .await;
    assert_eq!(r["data"]["content"], "world", "edit 后内容应更新");

    // rm
    let r = dispatch(
        &db,
        who,
        &req("fs.rm", serde_json::json!({ "channel_id": cid, "path": "notes/a.md" })),
    )
    .await;
    assert_eq!(r["ok"], true, "fs.rm 应成功: {r}");

    // read → NOT_FOUND
    let r = dispatch(
        &db,
        who,
        &req("fs.read", serde_json::json!({ "channel_id": cid, "path": "notes/a.md" })),
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
        &req("fs.read", serde_json::json!({ "channel_id": cid, "path": "x.md" })),
    )
    .await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "NOT_MEMBER", "非成员读应 NOT_MEMBER: {r}");

    let r = dispatch(
        &db,
        who,
        &req("fs.write", serde_json::json!({ "channel_id": cid, "path": "x.md", "content": "nope" })),
    )
    .await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "NOT_MEMBER", "非成员写应 NOT_MEMBER: {r}");
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
    assert_eq!(r["code"], "UNKNOWN_RESOURCE", "未知 verb 应 UNKNOWN_RESOURCE: {r}");
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
        &req("fs.rm", serde_json::json!({ "channel_id": cid, "path": "a.md" })),
    )
    .await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "PERMISSION_DENIED", "member 破坏性 rm 应被拒: {r}");
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
        &req("fs.rm", serde_json::json!({ "channel_id": cid, "path": "a.md" })),
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
        &req("fs.read", serde_json::json!({ "channel_id": ch.to_string(), "path": "x.md" })),
    )
    .await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "NOT_MEMBER", "非成员经 user 桥应 NOT_MEMBER: {r}");
}

// ── M2 Slice 2：fs.* 写入安全上限（DoS 防护）─────────────────────────────────
//
// user 桥让浏览器能写 memory_files（TEXT 入库 + 全量 WS 广播）。单文件硬上限
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
