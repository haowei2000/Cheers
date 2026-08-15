#![cfg(feature = "integration")]

use chrono::{Duration, NaiveTime, Utc};
use server::domain::scheduled_messages;
use sqlx::PgPool;
use uuid::Uuid;

async fn seed_due_task(db: &PgPool) -> String {
    let user = Uuid::new_v4().to_string();
    let workspace = Uuid::new_v4().to_string();
    let channel = Uuid::new_v4().to_string();
    let task = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO users (user_id,username,password_hash,display_name)
         VALUES ($1,$2,'x','Scheduler')",
    )
    .bind(&user)
    .bind(format!("scheduler-{user}"))
    .execute(db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO workspaces (workspace_id,name) VALUES ($1,'Automation tests')")
        .bind(&workspace)
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO channels (channel_id,workspace_id,name) VALUES ($1,$2,'scheduled')")
        .bind(&channel)
        .bind(&workspace)
        .execute(db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO workspace_memberships (workspace_id,user_id,role,status)
         VALUES ($1,$2,'member','active')",
    )
    .bind(&workspace)
    .bind(&user)
    .execute(db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO channel_memberships (channel_id,member_id,member_type)
         VALUES ($1,$2,'user')",
    )
    .bind(&channel)
    .bind(&user)
    .execute(db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO scheduled_messages
         (task_id,created_by,channel_id,title,content,schedule_kind,interval_minutes,next_run_at)
         VALUES ($1,$2,$3,'Daily review','Review deadlines','interval',1440,$4)",
    )
    .bind(&task)
    .bind(&user)
    .bind(&channel)
    .bind(Utc::now() - Duration::minutes(1))
    .execute(db)
    .await
    .unwrap();
    task
}

#[sqlx::test]
async fn due_task_is_leased_only_once(db: PgPool) {
    let task = seed_due_task(&db).await;
    let first = scheduled_messages::claim_due(&db).await.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].id, task);
    assert!(scheduled_messages::claim_due(&db).await.unwrap().is_empty());
}

#[sqlx::test]
async fn user_list_includes_schedule_and_channel(db: PgPool) {
    let task = seed_due_task(&db).await;
    let owner: String =
        sqlx::query_scalar("SELECT created_by FROM scheduled_messages WHERE task_id=$1")
            .bind(&task)
            .fetch_one(&db)
            .await
            .unwrap();
    let tasks = scheduled_messages::list(&db, owner.parse().unwrap())
        .await
        .unwrap();
    assert_eq!(tasks[0].channel_name, "scheduled");
    assert_eq!(tasks[0].schedule.every_minutes, Some(1440));
}

#[sqlx::test]
async fn daily_task_preserves_wall_clock_and_timezone(db: PgPool) {
    let task = seed_due_task(&db).await;
    sqlx::query(
        "UPDATE scheduled_messages SET schedule_kind='daily',interval_minutes=NULL,
         local_time='09:30',timezone='Europe/Berlin' WHERE task_id=$1",
    )
    .bind(&task)
    .execute(&db)
    .await
    .unwrap();
    let claimed = scheduled_messages::claim_due(&db).await.unwrap();
    assert_eq!(
        claimed[0].local_time.unwrap().format("%H:%M").to_string(),
        "09:30"
    );
    assert_eq!(claimed[0].timezone.as_deref(), Some("Europe/Berlin"));

    let next = scheduled_messages::next_daily_run(
        &db,
        NaiveTime::parse_from_str("09:30", "%H:%M").unwrap(),
        "Europe/Berlin",
    )
    .await
    .unwrap();
    let local: NaiveTime = sqlx::query_scalar("SELECT ($1::timestamptz AT TIME ZONE $2)::time")
        .bind(next)
        .bind("Europe/Berlin")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(local.format("%H:%M").to_string(), "09:30");
    assert!(next > Utc::now());
    assert!(next < Utc::now() + Duration::hours(26));
}
