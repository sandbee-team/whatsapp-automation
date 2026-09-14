-- db/seeds/demo-plan-assign.sql - dev/demo-only ASSIGNMENT of a plan to the
-- workspace owned by :'demo_email', using a fixed deterministic plan id
-- (d0000000-0000-4000-d000-000000000001, "Demo plan (dev only)") so re-runs
-- are idempotent (UPSERT, never a second plan row). No other row in this
-- database uses that id prefix (see queue-explain-fixture-remove.sql's own
-- prefix convention for the same reasoning).
--
-- WHY THIS EXISTS (2026-09-08, P26b U6 follow-up): `clients.plan_id` is
-- nullable and signup never assigns one (verified live 2026-09-08: 1,143 of
-- 1,148 dev clients are NULL). Every admission check that reads
-- `plan_limits` fails CLOSED without a plan - zero capacity, never
-- "unlimited" (core invariant 2, fail-safe): `POST /v1/contacts` ->
-- 409 CONTACT_LIMIT_REACHED (reason no_plan, contacts-limits.ts),
-- `POST /v1/instances` -> 409 REGISTERED_LIMIT_REACHED (maxRegisteredInstances
-- resolves to 0), and the broadcast fan-out snapshot -> BroadcastLimitError
-- reason no_plan (broadcasts/limits.ts). Assigning plans for real is a P28
-- admin/billing decision (a catalogue, pricing, self-serve upgrade flow -
-- none of which exist yet); this script is the narrow, honest, DEV-ONLY
-- unblock so a demo workspace seeded by `scripts/demo-seed.ts` can exercise
-- contacts/instances/broadcasts locally in the meantime.
--
-- Never runs against prod (db/seeds/README.md). One transaction: all or
-- nothing. Refuses (raises an exception, rolling back everything above)
-- when :'demo_email' matches zero clients, so a typo in the email never
-- silently no-ops.
--
--   docker exec -i wp-dev-postgres-1 psql -U wp -d wp -v ON_ERROR_STOP=1 -v demo_email='<email>' < db/seeds/demo-plan-assign.sql
--   (or, with the host psql:  psql -h 127.0.0.1 -p 55432 -U wp -d wp -v ON_ERROR_STOP=1 -v demo_email='<email>' -f db/seeds/demo-plan-assign.sql)

BEGIN;

INSERT INTO plans (id, name)
VALUES ('d0000000-0000-4000-d000-000000000001', 'Demo plan (dev only)')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now();

-- max_registered_instances (5) >= max_connected_instances (3), satisfying
-- plan_limits' own CHECK constraint (db/migrations/0002_tenancy.sql).
-- max_broadcast_recipients defaults to 20000 in the table DDL; this seed
-- picks a smaller, demo-appropriate 2000 explicitly instead of relying on
-- that default. max_contacts has no table default, so it is always supplied
-- here.
INSERT INTO plan_limits (
  plan_id, max_connected_instances, max_registered_instances,
  max_broadcast_recipients, max_contacts
)
VALUES ('d0000000-0000-4000-d000-000000000001', 3, 5, 2000, 5000)
ON CONFLICT (plan_id) DO UPDATE SET
  max_connected_instances = EXCLUDED.max_connected_instances,
  max_registered_instances = EXCLUDED.max_registered_instances,
  max_broadcast_recipients = EXCLUDED.max_broadcast_recipients,
  max_contacts = EXCLUDED.max_contacts;

-- psql does not substitute `:'name'` inside a dollar-quoted `DO $do$ ... $do$`
-- body (dollar-quoting is an opaque/raw string form by design - verified live
-- 2026-09-08: this file's own `WHERE u.email = :'demo_email'` inside the
-- $do$ body below was a hard syntax error even with the variable set, caught
-- by a read-only dry run against a real dev workspace). Fixed the same way as
-- db/seeds/dev-orphan-instances-remove.sql: the variable is resolved to a
-- real SQL value HERE, at the top level where interpolation does apply, and
-- the PL/pgSQL block below reads it back with a plain `SELECT ... INTO`.
CREATE TEMP TABLE demo_plan_assign_email ON COMMIT DROP AS
SELECT :'demo_email' AS demo_email;

-- Everything below runs as ONE PL/pgSQL block so the row counts can be
-- computed once, checked, and reported without psql meta-commands
-- (`\gset`) racing psql's own variable substitution inside a dollar-quoted
-- body - plain SQL only, matching this directory's other seeds.
DO $do$
DECLARE
  demo_email text;
  matched_clients int;
  updated_clients int;
BEGIN
  SELECT dpae.demo_email INTO demo_email FROM demo_plan_assign_email dpae;

  SELECT count(*) INTO matched_clients
  FROM clients c
  JOIN memberships m ON m.client_id = c.id
  JOIN users u ON u.id = m.user_id
  WHERE u.email = demo_email;

  IF matched_clients = 0 THEN
    RAISE EXCEPTION 'demo-plan-assign: no client found for demo_email=% - check the email and re-run (nothing was changed, transaction rolled back)', demo_email;
  END IF;

  WITH updated AS (
    UPDATE clients
    SET plan_id = 'd0000000-0000-4000-d000-000000000001', updated_at = now()
    WHERE plan_id IS NULL
      AND id IN (
        SELECT c.id
        FROM clients c
        JOIN memberships m ON m.client_id = c.id
        JOIN users u ON u.id = m.user_id
        WHERE u.email = demo_email
      )
    RETURNING id
  )
  SELECT count(*) INTO updated_clients FROM updated;

  RAISE NOTICE 'demo-plan-assign: matched % client(s) for demo_email=%, assigned plan to % (already had a plan: %)',
    matched_clients, demo_email, updated_clients, (matched_clients - updated_clients);
END
$do$;

COMMIT;
