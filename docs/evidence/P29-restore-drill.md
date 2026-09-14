# Restore drill - 2026-09-09T07:44:15.241Z

INTERNAL — restore drill evidence; no figure here is quotable (ADR 0016)

Mode: basebackup-scratch-container

Measured RTO: 01:34 at 925939379 bytes — ADR 0018 §7 claims ~1 h at ≤ 2,000 connected · 4-6 h at 10,000 · ~15 min via promotion; tier 5000 claims "4-6 h at 10,000 from backup (5,000 band)".

Measured RPO: 0s (0.0 min) against a 5-minute target; recovery point 2026-09-09T07:42:40.870Z; ok=true.

Ledger chain: 935 clients, 941 rows, 0 break(s); ok=true.

Capacity note (ADR 0018 §8): this drill measures restore time only; fleet capacity has been measured to the N stated in docs/capacity/fleet-capacity.md, and no figure on this page is a capacity claim.

Verdict: PASS

## Source / target

- Source: 127.0.0.1:55432/wp (schema version 75)
- Target: 127.0.0.1:55499/wp

## Backup

- Tool: pg_basebackup (format=tar, compression=none)
- Took: 9433 ms, 1760975872 bytes
- Dump path: (scratch container - see infra/backup/restore-drill.ts)

## Restore

- Took: 94371 ms (01:34)
- Source data size: 925939379 bytes
- Restored data size: 925939379 bytes

## Schema version

- Expected: 75, actual: 75, ok: true

## Table row counts (all public tables)

| table | source rows | restored rows | match |
| --- | ---: | ---: | --- |
| audit_logs | 4525 | 4525 | yes |
| audit_logs_y2026m08 | 76 | 76 | yes |
| audit_logs_y2026m09 | 4449 | 4449 | yes |
| audit_logs_y2026m10 | 0 | 0 | yes |
| audit_logs_y2026m11 | 0 | 0 | yes |
| audit_logs_y2032m01 | 0 | 0 | yes |
| audit_logs_y2032m02 | 0 | 0 | yes |
| audit_logs_y2032m03 | 0 | 0 | yes |
| audit_logs_y2032m06 | 0 | 0 | yes |
| audit_logs_y2032m07 | 0 | 0 | yes |
| audit_logs_y2032m08 | 0 | 0 | yes |
| auth_sessions | 374 | 374 | yes |
| campaign_counters | 503 | 503 | yes |
| campaign_recipients | 0 | 0 | yes |
| campaigns | 503 | 503 | yes |
| client_daily_usage | 1 | 1 | yes |
| client_limit_overrides | 1 | 1 | yes |
| client_pricing | 111 | 111 | yes |
| clients | 1193 | 1193 | yes |
| consent_records | 2 | 2 | yes |
| contact_import_errors | 2 | 2 | yes |
| contact_imports | 2 | 2 | yes |
| contact_tag_links | 0 | 0 | yes |
| contact_tags | 1 | 1 | yes |
| contacts | 60002 | 60002 | yes |
| content_fingerprint_recipients | 27 | 27 | yes |
| content_fingerprints | 17 | 17 | yes |
| delivery_event_ids | 6 | 6 | yes |
| delivery_events | 3789 | 3789 | yes |
| delivery_events_y2026w35 | 0 | 0 | yes |
| delivery_events_y2026w36 | 3789 | 3789 | yes |
| delivery_events_y2026w37 | 0 | 0 | yes |
| delivery_events_y2026w38 | 0 | 0 | yes |
| delivery_events_y2026w39 | 0 | 0 | yes |
| email_verification_tokens | 103 | 103 | yes |
| impersonation_grants | 0 | 0 | yes |
| inbound_dead_letters | 1 | 1 | yes |
| instance_health_samples | 1278 | 1278 | yes |
| instance_lease_state | 2050 | 2050 | yes |
| instance_pacing_overrides | 0 | 0 | yes |
| instance_pacing_state | 1027 | 1027 | yes |
| instance_recipient_contacts | 8 | 8 | yes |
| leads | 0 | 0 | yes |
| memberships | 103 | 103 | yes |
| message_job_refs | 4 | 4 | yes |
| message_jobs | 9 | 9 | yes |
| message_jobs_y2026m08 | 0 | 0 | yes |
| message_jobs_y2026m09 | 9 | 9 | yes |
| message_jobs_y2026m10 | 0 | 0 | yes |
| message_jobs_y2026m11 | 0 | 0 | yes |
| message_wa_ids | 0 | 0 | yes |
| mfa_recovery_codes | 670 | 670 | yes |
| notifications | 763 | 763 | yes |
| opt_outs | 0 | 0 | yes |
| optout_confirmations | 0 | 0 | yes |
| outbox_events | 0 | 0 | yes |
| pacing_events | 27 | 27 | yes |
| pacing_ledger | 0 | 0 | yes |
| pacing_profiles | 3 | 3 | yes |
| pacing_warmup_tiers | 18 | 18 | yes |
| password_reset_tokens | 0 | 0 | yes |
| plan_limits | 38 | 38 | yes |
| plans | 38 | 38 | yes |
| price_list_items | 4 | 4 | yes |
| price_lists | 1 | 1 | yes |
| recipient_send_buckets | 2 | 2 | yes |
| schema_migrations | 75 | 75 | yes |
| send_attempts | 3441 | 3441 | yes |
| staff_audit_log | 0 | 0 | yes |
| staff_sessions | 2 | 2 | yes |
| staff_users | 1 | 1 | yes |
| tenant_blocked_words | 0 | 0 | yes |
| tenant_optout_keywords | 0 | 0 | yes |
| topup_requests | 191 | 191 | yes |
| unresolved_action_keys | 309 | 309 | yes |
| users | 1840 | 1840 | yes |
| wa_groups | 0 | 0 | yes |
| wallet_accounts | 116 | 116 | yes |
| wallet_charge_guards | 30 | 30 | yes |
| wallet_charge_guards_y2026m08 | 0 | 0 | yes |
| wallet_charge_guards_y2026m09 | 30 | 30 | yes |
| wallet_charge_guards_y2026m10 | 0 | 0 | yes |
| wallet_charge_guards_y2026m11 | 0 | 0 | yes |
| wallet_charge_guards_y2032m01 | 0 | 0 | yes |
| wallet_charge_guards_y2032m02 | 0 | 0 | yes |
| wallet_charge_guards_y2032m03 | 0 | 0 | yes |
| wallet_charge_guards_y2032m06 | 0 | 0 | yes |
| wallet_charge_guards_y2032m07 | 0 | 0 | yes |
| wallet_charge_guards_y2032m08 | 0 | 0 | yes |
| wallet_daily_summary | 1 | 1 | yes |
| wallet_ledger | 941 | 941 | yes |
| wallet_ledger_ext_refs | 1947 | 1947 | yes |
| wallet_ledger_y2026m08 | 14 | 14 | yes |
| wallet_ledger_y2026m09 | 927 | 927 | yes |
| wallet_ledger_y2026m10 | 0 | 0 | yes |
| wallet_ledger_y2026m11 | 0 | 0 | yes |
| wallet_reconcile_findings | 9246 | 9246 | yes |
| webhook_deliveries | 6 | 6 | yes |
| webhook_endpoints | 0 | 0 | yes |
| whatsapp_instances | 2104 | 2104 | yes |
| whatsapp_session_credentials | 2030 | 2030 | yes |
| whatsapp_session_keys | 0 | 0 | yes |

## Named-table parity

| table | source rows | restored rows | exists |
| --- | ---: | ---: | --- |
| message_jobs | 9 | 9 | yes |
| wallet_ledger | 941 | 941 | yes |
| messages | 0 | 0 | no (not in v1) |
| contacts | 60002 | 60002 | yes |

## Claim query

- Rows returned: 1, ok: true
- Note: ran as the superuser connection (RLS FORCEd but bypassed by superuser); claimed inside BEGIN...ROLLBACK, never committed

## Plaintext scan

- Sentinels: noiseKey, signedIdentityKey, registrationId, advSecretKey
- Blob hits: 0, dump file hits: 0, ok: true

## Problems

(none)

## Notes

- RTO target ok=true; RPO target ok=true (see docs/evidence/P29-restore-drill.md for the honest delta if either misses)
