-- Native HTTP MCP uploads new agent attachments eagerly through inbox_deliver.
-- Historical staged rows contain only Connector-local paths, so the Gateway
-- cannot safely migrate their bytes. Mark them expired and remove the remote
-- locator to make the retirement explicit and prevent future realization.
UPDATE file_records
SET status = 'expired',
    remote_ref = NULL,
    expires_at = NOW()
WHERE status = 'staged';
