# ACP capability reject logs API (ops/troubleshooting)

This endpoint provides a pageable list of capability rejection decisions for ACP request
authorization failures. It is intended for frontend diagnostics and operations
triage.

## Endpoints

### Bot scoped query (owner/admin)

- `GET /api/v1/bots/:bot_id/capability-reject-logs`
- Permission: bot owner, admin, or system_admin

### Operations query (cross-bot, optional bot filter)

- `GET /api/v1/ops/capability-reject-logs`
- Permission: admin/system_admin
- Optional query `bot_id` for cross-bot filtering

## Common query params

| field | type | required | description |
| --- | --- | --- | --- |
| `delegation_id` | string | false | Filter by delegation id |
| `start_at` | string | false | ISO/RFC3339 lower bound (inclusive), e.g. `2026-05-30T00:00:00Z` |
| `end_at` | string | false | ISO/RFC3339 upper bound (inclusive), e.g. `2026-05-31T23:59:59Z` |
| `page` | integer | false | Page number, default `1` |
| `limit` | integer | false | Page size, default `50`, max `200` |
| `bot_id` | string | false | Only for `/api/v1/ops/capability-reject-logs` |

## Response format

```json
{
  "items": [
    {
      "log_id": 103,
      "bot_id": "b0b0b0b0-...",
      "provider_account_id": "provider-account-id",
      "delegation_id": "d0d0d0d0-...",
      "decision_scope_type": "session",
      "decision_scope_id": "topic-1",
      "frame_type": "resource_req",
      "action": "resource_req",
      "request_id": "req-...",
      "request_session_id": "s0s0...",
      "resolved_session_id": null,
      "resolved_session_status": "active",
      "resolved_session_scope_type": null,
      "resolved_session_scope_id": null,
      "session_locator_source": "connector",
      "session_locator_value": "local:abc",
      "resource": "provider.config",
      "decision_reason": "action not allowed",
      "created_at": "2026-05-31T09:12:34Z"
    }
  ],
  "meta": {
    "total": 128,
    "page": 2,
    "limit": 50,
    "has_more": true,
    "next_page": 3,
    "previous_page": 1
  }
}
```

## Notes

- `start_at`/`end_at` uses server RFC3339 parsing in UTC normalized format.
- `has_more` is derived via fetch-one-older-page check (`limit + 1` query pattern).
- For very large operations scans, always keep `page` and `limit` small and restrict
  by delegation/time range.

