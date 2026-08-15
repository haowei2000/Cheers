# Scheduled Messages

Scheduled messages are durable user-owned tasks whose only action is posting a normal
message into a Cheers channel. Mentioning a bot uses the same membership, consent,
availability, policy, persistence, fan-out, and dispatch path as a message sent from the
composer.

## First release

- `once`: run once at an absolute UTC timestamp.
- `interval`: repeat every 5 to 10,080 minutes. Missed intervals are skipped instead of
  replayed in a burst.
- `daily`: run at an `HH:MM` wall-clock time in an IANA timezone. PostgreSQL computes
  each next occurrence, preserving local time across daylight-saving changes.
- Tasks can be paused, resumed, edited, deleted, or run immediately.
- The API exposes the latest 50 runs for each task.

Cron, RRULE, weekly/monthly recurrences, event triggers, and webhooks are intentionally
not part of this release.

## Persistence

Migration `0080_scheduled_messages.sql` owns two tables:

- `scheduled_messages`: schedule, message payload, owner, channel, next run, lease, and
  latest status.
- `scheduled_message_runs`: one record per scheduled or manual execution. The unique
  `(task_id, scheduled_for, trigger)` key is the execution idempotency boundary.

The worker polls every 15 seconds and claims at most 20 due tasks with
`FOR UPDATE SKIP LOCKED`. A two-minute lease prevents concurrent gateways from claiming
the same task. If the process dies after creating the run record, the next worker marks
that run failed and advances the schedule rather than risking a duplicate message. This
is deliberate at-most-once delivery.

Failures proven to occur before message persistence, currently an unavailable mentioned
bot, retry after 1, 5, and 15 minutes. Each attempt has its own run record while retaining
the original scheduled timestamp. Ambiguous failures are never retried because doing so
could duplicate a message that was already committed.

## API

All endpoints are authenticated and scoped to the current user:

- `GET/POST /api/v1/scheduled-messages`
- `PUT/DELETE /api/v1/scheduled-messages/:taskId`
- `GET /api/v1/scheduled-messages/:taskId/runs`
- `POST /api/v1/scheduled-messages/:taskId/run`

Creating or updating a task verifies channel membership, mention targets, and external
AI consent. Execution checks those conditions again, so revoking access takes effect
without editing every task.

## Extension templates

An extension may contribute declarative Automation templates:

```json
{
  "contributes": {
    "automations": [{
      "id": "deadline-watch",
      "title": "Deadline watch",
      "description": "Review publication deadlines and planning risks.",
      "message": "Review publication deadlines and report planning risks.",
      "defaultSchedule": { "kind": "daily", "localTime": "09:00" }
    }]
  }
}
```

The template never runs at extension installation time. A user must create a task,
choose a channel and optional bot, and confirm the schedule. The resulting task has its
own lifecycle: uninstalling the extension does not silently delete a user's task.

Renderer code is not a scheduler. It may configure or display a task while open, but it
does not receive background execution, raw credentials, arbitrary REST access, or a
persistent JavaScript timer.
