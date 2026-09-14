-- Fixture (P03 close, note 12): ALTER TABLE ... SET (storage param) is a
-- DDL table attribute, never a session-scoped leak - must stay clean.
ALTER TABLE message_jobs SET (fillfactor = 90);
