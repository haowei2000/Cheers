-- Tail of the memory_files → context_files rename (0011): two constraints kept their
-- Postgres-auto-generated names (`memory_files_pkey`, `memory_files_channel_id_fkey`).
-- They're internal (never referenced in code), but renaming them leaves zero
-- "memory_files" anywhere in the live schema.
ALTER TABLE context_files RENAME CONSTRAINT memory_files_pkey TO context_files_pkey;
ALTER TABLE context_files
    RENAME CONSTRAINT memory_files_channel_id_fkey TO context_files_channel_id_fkey;
