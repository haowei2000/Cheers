-- Durable thread ancestry for Discuss channels. Roots keep NULL; every reply
-- stores the top-level root id so topic counts and recent-activity pagination do
-- not depend on whichever message window a client has loaded.
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS thread_root_msg_id VARCHAR(36);

-- Legacy reply linkage was not a database invariant. Preserve each message but
-- detach missing, cross-channel, or self-referential parents.
UPDATE messages AS child
SET in_reply_to_msg_id = NULL
WHERE child.in_reply_to_msg_id IS NOT NULL
  AND (
      child.in_reply_to_msg_id = child.msg_id
      OR NOT EXISTS (
          SELECT 1
          FROM messages AS parent
          WHERE parent.msg_id = child.in_reply_to_msg_id
            AND parent.channel_id = child.channel_id
      )
  );

WITH RECURSIVE thread_tree AS (
    SELECT m.msg_id, m.channel_id, m.msg_id AS root_msg_id
    FROM messages AS m
    WHERE m.in_reply_to_msg_id IS NULL

    UNION ALL

    SELECT child.msg_id, child.channel_id, tree.root_msg_id
    FROM messages AS child
    JOIN thread_tree AS tree
      ON tree.msg_id = child.in_reply_to_msg_id
     AND tree.channel_id = child.channel_id
)
UPDATE messages AS message
SET thread_root_msg_id = CASE
    WHEN tree.root_msg_id = message.msg_id THEN NULL
    ELSE tree.root_msg_id
END
FROM thread_tree AS tree
WHERE message.msg_id = tree.msg_id;

-- Anything still unresolved is a legacy cycle. Detach it instead of choosing an
-- arbitrary root whose meaning would vary by traversal order.
UPDATE messages
SET in_reply_to_msg_id = NULL,
    thread_root_msg_id = NULL
WHERE in_reply_to_msg_id IS NOT NULL
  AND thread_root_msg_id IS NULL;

-- Permission/auth cards are folded into their source turn. They inherit its
-- discussion without becoming independent topics.
UPDATE messages AS auxiliary
SET thread_root_msg_id = COALESCE(source.thread_root_msg_id, source.msg_id)
FROM messages AS source
WHERE auxiliary.in_reply_to_msg_id IS NULL
  AND auxiliary.msg_type IN ('permission', 'auth_required')
  AND auxiliary.content_data->>'source_msg_id' = source.msg_id
  AND auxiliary.channel_id = source.channel_id;

CREATE OR REPLACE FUNCTION cheers_set_message_thread_root()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    resolved_root VARCHAR(36);
    source_id VARCHAR(36);
BEGIN
    IF NEW.in_reply_to_msg_id IS NOT NULL THEN
        IF NEW.in_reply_to_msg_id = NEW.msg_id THEN
            RAISE EXCEPTION 'a message cannot reply to itself'
                USING ERRCODE = '23514';
        END IF;

        SELECT COALESCE(parent.thread_root_msg_id, parent.msg_id)
        INTO resolved_root
        FROM messages AS parent
        WHERE parent.msg_id = NEW.in_reply_to_msg_id
          AND parent.channel_id = NEW.channel_id;

        IF resolved_root IS NULL THEN
            RAISE EXCEPTION 'reply target must exist in the same channel'
                USING ERRCODE = '23514';
        END IF;

        IF resolved_root = NEW.msg_id THEN
            RAISE EXCEPTION 'reply relationship would create a cycle'
                USING ERRCODE = '23514';
        END IF;

        NEW.thread_root_msg_id := resolved_root;
        RETURN NEW;
    END IF;

    source_id := CASE
        WHEN NEW.msg_type IN ('permission', 'auth_required')
            THEN NEW.content_data->>'source_msg_id'
        ELSE NULL
    END;

    IF source_id IS NOT NULL AND source_id <> NEW.msg_id THEN
        SELECT COALESCE(source.thread_root_msg_id, source.msg_id)
        INTO resolved_root
        FROM messages AS source
        WHERE source.msg_id = source_id
          AND source.channel_id = NEW.channel_id;
        NEW.thread_root_msg_id := resolved_root;
    ELSE
        NEW.thread_root_msg_id := NULL;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_thread_root ON messages;
CREATE TRIGGER trg_messages_thread_root
BEFORE INSERT OR UPDATE OF in_reply_to_msg_id, channel_id, msg_type, content_data
ON messages
FOR EACH ROW
EXECUTE FUNCTION cheers_set_message_thread_root();

CREATE INDEX IF NOT EXISTS ix_messages_discussion_roots
    ON messages(channel_id, created_at DESC, msg_id DESC)
    WHERE thread_root_msg_id IS NULL
      AND is_partial = FALSE
      AND is_secret = FALSE;

CREATE INDEX IF NOT EXISTS ix_messages_thread_seq
    ON messages(channel_id, thread_root_msg_id, channel_seq)
    WHERE thread_root_msg_id IS NOT NULL
      AND is_partial = FALSE
      AND is_secret = FALSE;
