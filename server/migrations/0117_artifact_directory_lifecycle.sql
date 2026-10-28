-- A text file converted to a directory must retire its old artifact through the
-- same revision path as deletion. Directory entries themselves are not artifacts.
CREATE OR REPLACE FUNCTION channel_artifact_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE provider TEXT := CASE WHEN TG_TABLE_NAME = 'context_files' THEN 'text' ELSE 'attachment' END;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM channels WHERE channel_id = OLD.channel_id) THEN
            PERFORM sync_channel_artifact(provider, to_jsonb(OLD), TRUE);
        END IF;
        RETURN OLD;
    END IF;
    IF provider = 'text' AND TG_OP = 'UPDATE' THEN
        IF NEW.is_dir AND NOT OLD.is_dir THEN
            PERFORM sync_channel_artifact(provider, to_jsonb(OLD), TRUE);
            RETURN NEW;
        END IF;
    END IF;
    PERFORM sync_channel_artifact(provider, to_jsonb(NEW), FALSE);
    RETURN NEW;
END;
$$;
