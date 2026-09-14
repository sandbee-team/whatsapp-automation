-- Fixture (P14 C5 negative): a standalone SET search_path outside any
-- CREATE FUNCTION ... SECURITY DEFINER attribute clause is a real
-- session-scoped SET and must still be rejected.
SET search_path = 'public';
