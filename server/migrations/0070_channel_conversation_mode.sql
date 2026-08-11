-- Conversation presentation is independent from channel access (`type`) and
-- transport (`kind`). Existing channels retain the original chronological chat
-- behavior; owners may opt a channel into threaded discussion presentation.
ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS conversation_mode VARCHAR(16) NOT NULL DEFAULT 'chat'
    CHECK (conversation_mode IN ('chat', 'discuss'));
