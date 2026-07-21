-- Task-claim lifecycle + policy (design §6.3, Phase C2/C3): pending claims can
-- expire, be cancelled by claimant/admin, and be superseded by a later claim
-- on the same work. The status enum already includes 'cancelled'; this adds
-- the `expires_at` column + a `superseded_at` marker and the partial indexes
-- the expiry sweeper queries. It also adds the per-monitoring `policy` JSONB
-- that carries immediate-trigger keywords and quiet-hours windows the
-- scheduler consults to bypass debounce or pause evaluations.

ALTER TABLE task_claim_requests
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- The expiry sweeper only scans rows that can still transition: pending and
-- executing claims with a non-null expiry in the past.
CREATE INDEX IF NOT EXISTS ix_task_claim_requests_expiry
    ON task_claim_requests(status, expires_at)
    WHERE status IN ('pending', 'executing') AND expires_at IS NOT NULL;

-- Superseded lookup (a later claim links back to the claim it replaced).
CREATE INDEX IF NOT EXISTS ix_task_claim_requests_superseded
    ON task_claim_requests(channel_id, superseded_at)
    WHERE superseded_at IS NOT NULL;

-- Per-monitoring runtime policy: immediate-trigger keywords (skip debounce)
-- and quiet-hours windows (pause evaluations). Polymorphic with the other
-- CHECK constraints because it only applies when mode <> off.
ALTER TABLE channel_bot_monitoring
    ADD COLUMN IF NOT EXISTS policy JSONB NOT NULL DEFAULT '{}'::jsonb;
