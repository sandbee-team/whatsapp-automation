-- 0062 (P20 C1 round-3, ADR filed at P20 close): precise within-file dedupe provenance.
-- `import_id` records the import that CREATED the row and is deliberately never
-- overwritten (design §2.3's DO UPDATE list). `last_import_id` records the import
-- that most recently INSERTED OR UPDATED the row, so the runner can recognise
-- "already written by THIS import in an earlier batch" exactly, instead of the
-- time-based `updated_at >= import.created_at` heuristic that lost writes when
-- another actor touched the row mid-import. NULL for rows never touched by an import.
ALTER TABLE contacts ADD COLUMN last_import_id uuid;
