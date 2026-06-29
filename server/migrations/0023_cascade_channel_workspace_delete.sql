-- Make channel / workspace deletes work (audit: DELETE /channels|/workspaces
-- returned 500). Several FKs referencing channels(channel_id) and
-- workspaces(workspace_id) were created without ON DELETE CASCADE, so deleting a
-- parent row violated them and the gateway surfaced a 500.
--
-- Recreate every such FK with the right delete rule, name-independently (we look
-- up the actual constraint names from the catalog rather than guessing):
--   * NOT NULL child columns  -> ON DELETE CASCADE  (the row belongs to the parent)
--   * nullable child columns   -> ON DELETE SET NULL (optional reference survives)
-- FKs that are already CASCADE are skipped.
DO $$
DECLARE
  r RECORD;
  action TEXT;
BEGIN
  FOR r IN
    SELECT con.conname,
           cl.relname   AS child,
           att.attname  AS col,
           (NOT att.attnotnull) AS nullable,
           fcl.relname  AS parent,
           fatt.attname AS parent_col
    FROM pg_constraint con
    JOIN pg_class cl       ON cl.oid  = con.conrelid
    JOIN pg_class fcl      ON fcl.oid = con.confrelid
    JOIN pg_attribute att  ON att.attrelid  = con.conrelid  AND att.attnum  = con.conkey[1]
    JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = con.confkey[1]
    WHERE con.contype = 'f'
      AND fcl.relname IN ('channels', 'workspaces')
      AND con.confdeltype <> 'c'              -- skip ones already ON DELETE CASCADE
      AND array_length(con.conkey, 1) = 1     -- single-column FKs (all of ours)
  LOOP
    action := CASE WHEN r.nullable THEN 'SET NULL' ELSE 'CASCADE' END;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.child, r.conname);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(%I) ON DELETE %s',
      r.child, r.conname, r.col, r.parent, r.parent_col, action
    );
    RAISE NOTICE 'cascade-fixed: %.% -> %.% (ON DELETE %)',
      r.child, r.col, r.parent, r.parent_col, action;
  END LOOP;
END $$;
