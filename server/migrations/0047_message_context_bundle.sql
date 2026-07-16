-- Resource-context bundles (docs/design/RESOURCE_CONTEXT.md, F0).
--
-- A message may carry a `context_bundle`: an ordered list of references to Cheers
-- resources (plan / file / message / activity) — the Cheers-native `@context`,
-- attached by a human (manual pick) or a bot (automatic handoff). References point
-- at existing resource verbs; the receiving agent resolves them as itself
-- (consumer-governed reads), so the column stores only refs + small previews, not
-- authoritative content. JSONB column (not a side table) per the design decision.
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS context_bundle JSONB;
