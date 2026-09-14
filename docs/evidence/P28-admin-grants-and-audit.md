# P28 evidence — admin role grants and the staff audit trail

Phase: P28 `admin-internal-api-and-panel` · Date: 2026-09-08 · Database: dedicated `wp_test2` (schema version 73) · Gate test: `db/tests/grants-snapshot-p28-admin-role.test.ts`

This file is the evidence the phase's Definition of Done asks for: the verbatim grant surface of `wp_admin_app`
(the role `admin/backend` runs as), proving it cannot write a single send-path table, plus the two demo
staff actions (a client suspend and a wallet adjustment) with their `staff_audit_log` rows and the tenant
notifications they produced. Ids and enums only — no phone number, message body, contact name, email or
wallet `external_ref` appears here, by construction of the projections and by the reviewer's check.

## 1. Role facts (`pg_roles`, `wp_test2`, 2026-09-08 16:30 IST)

```text
wp_admin_app bypassrls=true
wp_app bypassrls=false
schema_migrations max=73
```

`wp_admin_app` is BYPASSRLS **SELECT** (cross-tenant reads for staff) and nothing else on the tenant data
plane. `wp_app` is the only application role that writes tenant data, always under `FORCE ROW LEVEL
SECURITY` and the `app.client_id` GUC.

## 2. The gate — `wp_admin_app` has no write grant on any send-path table (verbatim `psql` output)

```text
=== send-path tables: wp_admin_app write grants ===
       table_name       | write_grants
------------------------+--------------
 campaign_recipients    |            0
 delivery_events        |            0
 message_jobs           |            0
 messages               |            0
 pacing_ledger          |            0
 send_attempts          |            0
 wallet_charge_guards   |            0
 wallet_ledger          |            0
 wallet_ledger_ext_refs |            0
 whatsapp_instances     |            0
(10 rows)
```

Query: `count(privilege_type) FILTER (WHERE privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE'))` over
`information_schema.role_table_grants` for `grantee = 'wp_admin_app'`, left-joined so a table with no grant
row at all still appears (as `0`). `messages` does not exist in v1 (the inbox product is v2, ADR 0021); it
is listed so the nine-table assertion in the phase file stays honest — the gate test asserts at least eight
of the nine exist, then zero write grants on each existing one and on every partition child.

## 3. The complete write surface of `wp_admin_app` (verbatim `psql` output, partition children collapsed)

```text
=== wp_admin_app table-level write grants ===
   table_name   | privilege_type
----------------+----------------
 audit_logs     | INSERT
 staff_sessions | INSERT
 staff_sessions | UPDATE
 staff_users    | INSERT
 staff_users    | UPDATE
(5 rows)

=== wp_admin_app column-scoped write grants ===
   table_name   | privilege_type |                      string_agg
----------------+----------------+-------------------------------------------------------
 topup_requests | UPDATE         | review_reason,reviewed_at,reviewed_by_staff_id,status
(1 row)
```

Why each grant exists:

| Grant                                                       | Owner                | Reason                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit_logs` INSERT                                         | migration 0070       | `admin/backend/src/platform/platform-read.ts#platformRead` writes an `audit_logs` row (`action='platform.read'`, `actor_type='staff'`) in the **same transaction** as every cross-tenant read; a rolled-back read leaves no row. Append-only audit table, not a send-path table. |
| `staff_users` INSERT/UPDATE, `staff_sessions` INSERT/UPDATE | migration 0070       | `admin/backend` authenticates staff (argon2id + mandatory TOTP + IP allow-list), maintains lockout counters, `token_epoch`, and rotating refresh sessions. Non-tenant tables (`ISOLATION_NON_TENANT_TABLES`).                                                                    |
| `topup_requests` UPDATE (4 columns)                         | migration 0058 (P19) | the staff approve/reject status flip; the internal API runs it via `SET LOCAL ROLE wp_admin_app` inside `withStaffMutation`'s transaction (`tx.asAdminRole`).                                                                                                                    |

`db/tests/grants-snapshot-p28-admin-role.test.ts#wp_admin_app_write_surface_is_exactly_the_pinned_set`
pins this table by set-equality; any future widening is a red test, not a silent drift. The full role/table/
column dump is `db/schema/grants.snapshot.json` (regenerated three times this phase: 0070/0071, 0072, 0073).

## 4. Grants that were MISSING for `wp_app` and are fixed this phase (pre-existing defects, same class)

| Migration | Grant                                              | Found by                                                                                                                                                                                     |
| --------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0072      | `UPDATE (seq) ON wallet_ledger_ext_refs TO wp_app` | `withStaffMutation` is the first code path that really enters `wp_app` (`SET LOCAL ROLE wp_app`) before running `db/queries/wallet-credit.sql`'s `wallet-credit-stamp-ext-ref` UPDATE.       |
| 0073      | `SELECT, INSERT, UPDATE ON campaigns TO wp_app`    | the staff campaign-cancel route; migration 0064 granted the two sibling campaign tables but never `campaigns` itself, so every tenant broadcast path would 42501 under a real `wp_app` pool. |

Both were invisible for six phases because the dev/test pool connects as the database owner and
`TenantDb.withTenant` issues no `SET LOCAL ROLE`. **Founder/ops check (carried to the session log and
`.memory/progress/master-plan.md`):** confirm which role the production pool connects as; if it is `wp_app`,
the wallet credit stamp and every broadcast write were broken until 0072/0073. A structural fix (run backend
integration suites under a non-BYPASSRLS, non-owner role) is the long-open item from P06-P08.

## 5. The demo — staff suspend a client and adjust a wallet (ids and enums only)

Command: `DATABASE_URL=... WP_ENV=test WP_LOG_LEVEL=info WP_KEY_RING_PATH=test-key-ring-path-not-a-real-secret
WP_KEK_PURPOSES=session WP_ENC_VERSION=1 pnpm exec tsx scripts/p28-staff-demo.ts` (run from `app/backend`,
against `wp_test2`) · Exit code: `0`

````text
Probe client: `66b3fa9b` · staff: `a75452b8` (role `ops`, suspend/reactivate) and `a191bb9f` (role `superadmin`, wallet adjust)

### staff_audit_log
| id | staff_id | action | client_id | target_kind | target_ref | reason | idempotency_key | result | created_at |
|---|---|---|---|---|---|---|---|---|---|
| 263 | a75452b8 | clients.suspend | 66b3fa9b | client | 66b3fa9b | P28 evidence demo: suspend | b081f545 | {"clientId":"66b3fa9b-cfdd-400f-8b2f-8cf71677402b","status":"suspended","changed":true} | 2026-09-08 11:20:44.043783+00 |
| 264 | a191bb9f | wallet.adjust | 66b3fa9b | client | 66b3fa9b | P28 evidence demo: goodwill credit | de8f1d51 | {"clientId":"66b3fa9b-cfdd-400f-8b2f-8cf71677402b","seq":"1","state":"active"} | 2026-09-08 11:20:44.077112+00 |

### notifications (ids/enums only, no payload text)
| id | kind | severity | instance_id | dedupe_key | created_at |
|---|---|---|---|---|---|
| 095ea840-a444-415e-86ba-d003bf75a788 | client_suspended | critical |  | 7506f05b1c7665b6db6b4719057159839d77819a2c9aed5e50eb304b5bb31ae7 | 2026-09-08 11:20:44.043783+00 |
| 91be3a25-183e-4f6f-bab5-c26c3d730467 | wallet_credited_by_staff | info |  | 4439f7d50ead90a57cdd43fe30593e37102371ab419afd7dc164de144e2a93a3 | 2026-09-08 11:20:44.077112+00 |

### wallet_ledger
| seq | kind | amount_minor | balance_after_minor | actor_type | actor_staff_id |
|---|---|---|---|---|---|
| 1 | adjustment_credit | 2500 | 42500 | staff | a191bb9f |

wallet_accounts.state after adjust: `active`

### message_jobs status counts (probe client, both instances)
```text
{"queued":6}
```

### publishWake calls recorded on reactivate
```text
clientId=66b3fa9b instanceId=22ccf27a
clientId=66b3fa9b instanceId=5c404527
```
````

All probe rows created by this run (the client, its two instances, the six queued jobs, both staff users, the
two `staff_audit_log` rows, the two `notifications` rows, and the `wallet_ledger`/`wallet_accounts` rows) were
deleted by the script's own cleanup before it exited, verified by re-querying `wp_test2` for the same ids
afterward (zero rows).

## 6. Honest scope of "every read is audited"

`platformRead()` audits every cross-tenant read that goes through `admin/backend`. Triggers do not fire on
`SELECT`, and `pgaudit` is **not** enabled in v1, so a staff member with raw `psql` access as `wp_admin_app`
is **not** audited. `docs/RUNBOOK.md` → `## staff-accounts` states this plainly; the claim made to tenants is
"support access through the admin console is logged and time-boxed", nothing wider.
