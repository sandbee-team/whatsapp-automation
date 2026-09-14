-- contacts-active-clients.sql (P20 Unit U8, step 8) - a bounded, cursor-
-- paginated cross-tenant CLIENT WALK shared by the two contacts maintenance
-- sweeps (the opt-out mirror reconciler and the import-error/object
-- retention purge, `engine/cron/cron-wiring-contacts-maintenance.ts`).
-- Unlike `contact-imports-pending-clients.sql` (which only returns clients
-- with an in-flight import), this scans EVERY live client - the mirror
-- reconciler and the retention purge both need to sweep every tenant, not
-- just tenants mid-import - so it is bounded by `$after_id`/`$limit`
-- (ADR 0018 S4: never O(active) per tick beyond `$limit`), never an
-- unbounded scan. The caller wraps the rotating cursor (wrap to the nil
-- uuid once a page comes back empty), this statement itself is stateless.

-- name: contacts-active-clients
SELECT id AS client_id
  FROM clients
 WHERE deleted_at IS NULL AND id > $after_id
 ORDER BY id
 LIMIT $limit;
