-- instance-create.sql (P08 Unit U4) - TENANT-ACTION write (API route, no
-- lease/fence involved - see repo.ts's own "two write families" header
-- comment). Minimal full-row INSERT: only `id`, `client_id`, `label` are
-- ever supplied by the caller - every other column rides its own table
-- DEFAULT (link_state 'unlinked', health_state 'never_linked', desired_state
-- 'offline', session_epoch 0, qr_attempts 0 - migration 0010's CREATE TABLE).
-- `client_id = $client_id` is both the literal column value AND, under
-- wp_app, checked again by the table's FORCE RLS `tenant_isolation`
-- WITH CHECK policy - the same "double-enforced, not merely convention"
-- shape every other tenant-table write in this schema relies on.

-- name: instance-create
INSERT INTO whatsapp_instances (id, client_id, label)
VALUES ($id, $client_id, $label)
-- client_id = $client_id
RETURNING id;
