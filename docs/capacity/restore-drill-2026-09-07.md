# Restore drill - 2026-09-07T13:35:20.410Z

INTERNAL — restore drill evidence; no figure here is quotable (ADR 0016)

Measured RTO: 00:04 at 1036261043 bytes — ADR 0018 §7 claims ~1 h at ≤ 2,000 connected · 4-6 h at 10,000 · ~15 min via promotion; tier 5000 claims "4-6 h at 10,000 from backup (5,000 band)".

Capacity note (ADR 0018 §8): this drill measures restore time only; fleet capacity has been measured to the N stated in docs/capacity/fleet-capacity.md, and no figure on this page is a capacity claim.

Verdict: PASS

## Source / target

- Source: 127.0.0.1:55432/wp (schema version 69)
- Target: 127.0.0.1:55432/wp_restore_drill_20260907-190511

## Backup

- Tool: pg_dump (format=custom, compression=none)
- Took: 4249 ms, 232166650 bytes
- Dump path: C:\Users\KARTIK~1.DES\AppData\Local\Temp\wp-restore-drill-20260907-190511.dump

## Restore

- Took: 4377 ms (00:04)
- Source data size: 1036261043 bytes
- Restored data size: 312948403 bytes

## Schema version

- Expected: 69, actual: 69, ok: true

## Table row counts

| table                          | source rows | restored rows | match |
| ------------------------------ | ----------: | ------------: | ----- |
| audit_logs                     |        3831 |          3831 | yes   |
| audit_logs_y2026m08            |          76 |            76 | yes   |
| audit_logs_y2026m09            |        3755 |          3755 | yes   |
| audit_logs_y2026m10            |           0 |             0 | yes   |
| audit_logs_y2026m11            |           0 |             0 | yes   |
| audit_logs_y2032m01            |           0 |             0 | yes   |
| audit_logs_y2032m02            |           0 |             0 | yes   |
| audit_logs_y2032m03            |           0 |             0 | yes   |
| audit_logs_y2032m06            |           0 |             0 | yes   |
| audit_logs_y2032m07            |           0 |             0 | yes   |
| audit_logs_y2032m08            |           0 |             0 | yes   |
| auth_sessions                  |          97 |            97 | yes   |
| campaign_counters              |           6 |             6 | yes   |
| campaign_recipients            |           0 |             0 | yes   |
| campaigns                      |           6 |             6 | yes   |
| client_daily_usage             |           4 |             4 | yes   |
| client_limit_overrides         |           1 |             1 | yes   |
| client_pricing                 |          66 |            66 | yes   |
| clients                        |        1152 |          1152 | yes   |
| consent_records                |           2 |             2 | yes   |
| contact_import_errors          |           2 |             2 | yes   |
| contact_imports                |           2 |             2 | yes   |
| contact_tag_links              |           0 |             0 | yes   |
| contact_tags                   |           1 |             1 | yes   |
| contacts                       |       60002 |         60002 | yes   |
| content_fingerprint_recipients |          27 |            27 | yes   |
| content_fingerprints           |          17 |            17 | yes   |
| delivery_event_ids             |        7433 |          7433 | yes   |
| delivery_events                |       11216 |         11216 | yes   |
| delivery_events_y2026w35       |           0 |             0 | yes   |
| delivery_events_y2026w36       |        3789 |          3789 | yes   |
| delivery_events_y2026w37       |        7427 |          7427 | yes   |
| delivery_events_y2026w38       |           0 |             0 | yes   |
| delivery_events_y2026w39       |           0 |             0 | yes   |
| email_verification_tokens      |          55 |            55 | yes   |
| inbound_dead_letters           |           1 |             1 | yes   |
| instance_health_samples        |         678 |           678 | yes   |
| instance_lease_state           |        3085 |          3085 | yes   |
| instance_pacing_overrides      |           0 |             0 | yes   |
| instance_pacing_state          |        2025 |          2025 | yes   |
| instance_recipient_contacts    |           8 |             8 | yes   |
| memberships                    |          55 |            55 | yes   |
| message_job_refs               |      303791 |        303791 | yes   |
| message_jobs                   |      303795 |        303795 | yes   |
| message_jobs_y2026m08          |           0 |             0 | yes   |
| message_jobs_y2026m09          |      243795 |        243795 | yes   |
| message_jobs_y2026m10          |       40000 |         40000 | yes   |
| message_jobs_y2026m11          |       20000 |         20000 | yes   |
| message_wa_ids                 |        3713 |          3713 | yes   |
| mfa_recovery_codes             |         460 |           460 | yes   |
| notifications                  |         393 |           393 | yes   |
| opt_outs                       |           0 |             0 | yes   |
| optout_confirmations           |           0 |             0 | yes   |
| outbox_events                  |          30 |            30 | yes   |
| pacing_events                  |           5 |             5 | yes   |
| pacing_ledger                  |        1000 |          1000 | yes   |
| pacing_profiles                |           3 |             3 | yes   |
| pacing_warmup_tiers            |          18 |            18 | yes   |
| password_reset_tokens          |           0 |             0 | yes   |
| plan_limits                    |          34 |            34 | yes   |
| plans                          |          34 |            34 | yes   |
| price_list_items               |           4 |             4 | yes   |
| price_lists                    |           1 |             1 | yes   |
| recipient_send_buckets         |           2 |             2 | yes   |
| schema_migrations              |          69 |            69 | yes   |
| send_attempts                  |        7155 |          7155 | yes   |
| staff_audit_log                |           0 |             0 | yes   |
| tenant_blocked_words           |           0 |             0 | yes   |
| tenant_optout_keywords         |           0 |             0 | yes   |
| topup_requests                 |         185 |           185 | yes   |
| unresolved_action_keys         |         305 |           305 | yes   |
| users                          |        1726 |          1726 | yes   |
| wa_groups                      |           0 |             0 | yes   |
| wallet_accounts                |          75 |            75 | yes   |
| wallet_charge_guards           |        3742 |          3742 | yes   |
| wallet_charge_guards_y2026m08  |           0 |             0 | yes   |
| wallet_charge_guards_y2026m09  |        3742 |          3742 | yes   |
| wallet_charge_guards_y2026m10  |           0 |             0 | yes   |
| wallet_charge_guards_y2026m11  |           0 |             0 | yes   |
| wallet_charge_guards_y2032m01  |           0 |             0 | yes   |
| wallet_charge_guards_y2032m02  |           0 |             0 | yes   |
| wallet_charge_guards_y2032m03  |           0 |             0 | yes   |
| wallet_charge_guards_y2032m06  |           0 |             0 | yes   |
| wallet_charge_guards_y2032m07  |           0 |             0 | yes   |
| wallet_charge_guards_y2032m08  |           0 |             0 | yes   |
| wallet_daily_summary           |           1 |             1 | yes   |
| wallet_ledger                  |        4574 |          4574 | yes   |
| wallet_ledger_ext_refs         |        1838 |          1838 | yes   |
| wallet_ledger_y2026m08         |          14 |            14 | yes   |
| wallet_ledger_y2026m09         |        4560 |          4560 | yes   |
| wallet_ledger_y2026m10         |           0 |             0 | yes   |
| wallet_ledger_y2026m11         |           0 |             0 | yes   |
| wallet_reconcile_findings      |        7861 |          7861 | yes   |
| webhook_deliveries             |           6 |             6 | yes   |
| webhook_endpoints              |           0 |             0 | yes   |
| whatsapp_instances             |        3137 |          3137 | yes   |
| whatsapp_session_credentials   |        3078 |          3078 | yes   |
| whatsapp_session_keys          |           0 |             0 | yes   |

## Claim query

- Rows returned: 1, ok: true
- Note: ran as the superuser connection (RLS FORCEd but bypassed by superuser); claimed inside BEGIN...ROLLBACK, never committed

## Plaintext scan

- Sentinels: noiseKey, signedIdentityKey, registrationId, advSecretKey
- Blob hits: 0, dump file hits: 0, ok: true

## Problems

(none)

## Notes

(none)
