-- Shareable invite links (Slack/Discord-style). A workspace admin mints a link;
-- ANYONE holding the URL may join the workspace — possession of the token IS the
-- authorization (optionally bounded by an expiry and a use budget, and revocable
-- at any time). This is deliberately different from the two consent-based invite
-- kinds (0025 pending workspace_memberships / 0043 channel_invites), which target
-- a KNOWN user: a link targets people the admin can't look up — most importantly
-- people with no account yet (the register flow accepts a valid invite token in
-- place of `open_registration`).
--
-- Unlike enrollment codes (0024, credentials that unlock a bot's secrets → hash-
-- only at rest), the token is stored in PLAINTEXT: links are meant to be re-read
-- and re-copied from the management UI for their whole lifetime, and what a
-- leaked row grants (plain 'member' entry into one workspace) is bounded and
-- revocable. The token still carries 128 bits of CSPRNG entropy, so guessing is
-- infeasible; the public endpoints are rate-limited on top.
--
-- channel_id scopes a link to a PUBLIC channel: redeeming also drops the joiner
-- into that channel. Membership-wise it grants nothing beyond the workspace join
-- (any active workspace member may self-join a public channel — 0001
-- allow_member_invites / the /join endpoint), so minting stays a workspace-admin
-- decision; private channels keep the consent-based path as the only way in.
CREATE TABLE IF NOT EXISTS invite_links (
    link_id      VARCHAR(36)  PRIMARY KEY,
    -- `cinv_<128-bit hex>` bearer token, embedded in the shared URL.
    token        VARCHAR(64)  NOT NULL UNIQUE,
    workspace_id VARCHAR(36)  NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    channel_id   VARCHAR(36)  REFERENCES channels(channel_id) ON DELETE CASCADE,
    created_by   VARCHAR(36)  NOT NULL REFERENCES users(user_id),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- NULL = never expires.
    expires_at   TIMESTAMPTZ,
    -- NULL = unlimited uses. A "use" is one NEW workspace membership created
    -- through the link (re-clicks by existing members don't consume).
    max_uses     INTEGER,
    use_count    INTEGER      NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    revoked      BOOLEAN      NOT NULL DEFAULT FALSE
);

-- Management list + the per-workspace live-link cap.
CREATE INDEX IF NOT EXISTS ix_invite_links_workspace ON invite_links (workspace_id);
