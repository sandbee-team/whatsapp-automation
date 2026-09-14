import { afterAll, describe, expect, it } from 'vitest';
import { getMigratedPool, closeMigratedPool } from './helpers/migrated-db.js';
import { fetchCanonicalColumnGrants } from './helpers/grants-canonical.js';

/**
 * grants-scheduler-columns.test.ts - split out of `grants-snapshot.test.ts`
 * at the P11 close for the max-lines cap (topic split only; the case and its
 * assertions are unchanged apart from migration 0025's deliberate widening,
 * documented inline below).
 *
 * This is the evidence that `wp_scheduler`'s column-level narrowing on
 * `message_jobs` actually holds in the live database - not hand-verification
 * of a migration file. A future widening must touch this pin DELIBERATELY,
 * exactly as P11 did here.
 */
describe('grants_scheduler_columns', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('wp_scheduler_message_jobs_column_grants_match_the_claim_exactly', async () => {
    const pool = await getMigratedPool();
    const columnGrants = await fetchCanonicalColumnGrants(pool);

    const messageJobsGrants = columnGrants.filter(
      (row) => row.grantee === 'wp_scheduler' && row.table_name === 'message_jobs',
    );

    // Pinned to migration 0012's claim column lists (P03 close, finding 3)
    // PLUS migration 0025's result-writer widening (P11 send-path-mvp) PLUS
    // migration 0026's reaper/reconciler widening (P12 U1) - this is the
    // evidence that the narrowing actually holds, not hand-verification of
    // the migration files. 0012's own header predicted this exact widening
    // ("the P0x result-writer that records sent/failed will need additional
    // message_jobs columns ... ADDITIVE grants in THEIR OWN migrations"),
    // and the pin above said a future widening "must touch this pin
    // deliberately" - P11 and P12 are those phases, and this IS that
    // deliberate touch. Verified against the live DB that 0025/0026 granted
    // EXACTLY these and nothing broader.
    //
    // 0025 adds:
    //   SELECT + max_attempts        - the retry-budget exhaustion check
    //                                  (result-retry-budget.ts); without it
    //                                  RETRY_BACKOFF retries unbounded until
    //                                  mj_attempts_range throws mid-dispatch.
    //   UPDATE + sent_at, failed_at, terminal_at, last_error_class,
    //           next_attempt_at, cancel_reason, attempts
    //                                - the result write (result.ts) and
    //                                  dispatch's attempts increment.
    //
    // 0026 (P12 U1) adds, closing the gap 0012:50-55 reserved for "the
    // reaper's own migration":
    //   SELECT + lease_expires_at, leased_at, lease_owner, owner_fence,
    //           terminal_at, sent_at
    //                                - the reaper's poll/repair statement and
    //                                  the repaired-send-sink idempotency
    //                                  read-back (0026 header).
    //   UPDATE + needs_user_action, unresolved_reason, unresolved_at
    //                                - the reaper's dispatched->needs_reconcile
    //                                  repair and the reconciler's window-
    //                                  expiry -> blocked_needs_review branch.
    const select = messageJobsGrants.find((row) => row.privilege_type === 'SELECT');
    const update = messageJobsGrants.find((row) => row.privilege_type === 'UPDATE');

    expect(select?.columns).toEqual(
      [
        'id',
        'created_at',
        'client_id',
        'instance_id',
        'session_epoch',
        'campaign_id',
        'status',
        'priority_rank',
        'next_attempt_at',
        'scheduled_at',
        'recipient_jid',
        'payload',
        'payload_kind',
        'attempts',
        'lease_id',
        // migration 0025 (P11): the retry-budget exhaustion check.
        'max_attempts',
        // migration 0026 (P12 U1): the reaper + repaired-send-sink.
        'lease_expires_at',
        'leased_at',
        'lease_owner',
        'owner_fence',
        'terminal_at',
        'sent_at',
        // migration 0032 (P13 correctness fix): claim-jobs.sql's RETURNING
        // list now surfaces the job's own stored cold-outreach
        // classification so claimAndReserve() can pass the REAL
        // $is_new_conversation into reserve-pacing.sql instead of a
        // hardcoded false.
        'is_new_conversation',
        // migration 0037 (P14 Unit U4): claim-jobs.sql's RETURNING list now
        // also surfaces recipient_hash/send_origin/content_fingerprint so
        // the opt-out gate and the exempt-origin pacing reserve can run
        // without a second round trip.
        'recipient_hash',
        'send_origin',
        'content_fingerprint',
        // migration 0040 (P14 review-fix F1/F2) Part 2: defer-job.sql's own
        // `pacing_deferrals = pacing_deferrals + 1` self-read, and
        // dispose-job.sql's `last_error_class = CASE ... ELSE
        // last_error_class END` / `failed_at = CASE ... ELSE failed_at END`
        // self-reads - an UPDATE's SET-list self-reference needs SELECT on
        // that column in addition to UPDATE (see 0040's own header).
        'pacing_deferrals',
        'last_error_class',
        'failed_at',
      ].sort(),
    );
    expect(update?.columns).toEqual(
      [
        'status',
        'lease_owner',
        'lease_id',
        'owner_fence',
        'leased_at',
        'lease_expires_at',
        'pacing_reserved_at',
        'pacing_ledger_date',
        'updated_at',
        // migration 0025 (P11 send-path-mvp) - the result writer.
        'sent_at',
        'failed_at',
        'terminal_at',
        'last_error_class',
        'next_attempt_at',
        'cancel_reason',
        'attempts',
        // migration 0026 (P12 U1) - the reaper + reconciler unresolved path.
        'needs_user_action',
        'unresolved_reason',
        'unresolved_at',
        // migration 0039 (P14 Unit U6) - the guard pipeline's own defer/
        // dispose writes (defer-job.sql / dispose-job.sql). Live-verified
        // against the migrated DB while fixing this pin's own SELECT half
        // (P14 review-fix F2, seed-fallout close-out) - this UPDATE grant
        // already existed but this pin had never been touched to reflect
        // it.
        'pacing_deny_reason',
        'pacing_deferrals',
      ].sort(),
    );

    // Non-vacuous: wp_scheduler must hold exactly these two privileges on
    // message_jobs, nothing broader (no table-level grant reintroduced).
    expect(messageJobsGrants.map((row) => row.privilege_type).sort()).toEqual(['SELECT', 'UPDATE']);
  });
});
