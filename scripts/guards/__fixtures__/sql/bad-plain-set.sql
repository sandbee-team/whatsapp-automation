-- Fixture: plain SET is banned in raw SQL (transaction pooling makes a
-- session-scoped SET a cross-tenant leak) - this file deliberately violates
-- sql-lint's no-plain-set clause.
SET search_path = public;

SELECT 1;
