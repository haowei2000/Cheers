-- Surface IDs can be 128 characters; the renderer and schema suffix also belong
-- in the view identity. Existing drafts keep their keys and revisions unchanged.
ALTER TABLE resource_view_drafts ALTER COLUMN view_id TYPE VARCHAR(256);
