-- P18 (wallet-ledger-and-pricing) Unit U1 fix - migration 0052. Forward-only, additive: one index, nothing else.
-- `wallet_charge_guards` sits on SUITE_A_INDEX_EXEMPTIONS only for its UNIQUE index (the PK leading with
-- send_attempt_id - the idempotency authority). The separate suite-A rule "every registered tenant table has at
-- least one client_id-leading index" (isolation-suite-a.test.ts) has no exemption mechanism, deliberately: the
-- RLS predicate `client_id = current_setting(...)` and every per-tenant reconciler/cleanup read need an indexable
-- tenant prefix. A partitioned index on the parent is auto-created on every existing and future child
-- (CREATE TABLE ... PARTITION OF attaches matching indexes).
CREATE INDEX wallet_charge_guards_client_created_idx ON wallet_charge_guards (client_id, created_at);
