import type { AdminReadQueryable } from '../../platform/platform-read.js';

/**
 * modules/clients/write-attempt-probe.read.ts (P28 Unit U4, step 7) -
 * TEST-ONLY, and never reachable from any route. Its single function
 * deliberately attempts a write to a SEND-PATH table (`message_jobs`) from
 * inside `platformRead()`, to prove that the "admin/backend never writes
 * anything but audit_logs/staff_users/staff_sessions" invariant (ADR 0014
 * fact 1/12) is enforced by the DATABASE GRANT SURFACE rather than by
 * application discipline.
 *
 * `wp_admin_app` holds no INSERT grant on `message_jobs`, so Postgres
 * refuses this statement with SQLSTATE `42501` (insufficient_privilege).
 * `platformRead` catches that, logs a `platform_read_write_attempt` defect
 * line, rolls the transaction back (taking its own audit row with it) and
 * surfaces an `INTERNAL` error - see
 * `clients.read.integration.test.ts#admin_backend_never_opens_a_write_connection_to_a_send_path_table`.
 *
 * This is a probe, not a feature: it exists so that if someone ever DID
 * widen `wp_admin_app`'s grants, a test would go red immediately instead of
 * the widening being discovered by a corrupted tenant queue. It is
 * registered in `cross-tenant-queries-p28-admin.ts` and
 * `platform/registered-reads.ts` like any other read, so the registry
 * honestly describes every span in this tree - including the one whose
 * entire purpose is to fail.
 */
export async function attemptSendPathWrite(db: AdminReadQueryable): Promise<void> {
  await db.query(
    `INSERT INTO message_jobs
       (client_id, instance_id, recipient_jid, payload, payload_kind, priority, priority_rank, status)
     VALUES ($1, $2, $3, $4::jsonb, 'text', 'normal', 50, 'queued')`,
    [
      '00000000-0000-4000-8000-000000000000',
      '00000000-0000-4000-8000-000000000000',
      'probe@s.whatsapp.net',
      JSON.stringify({ probe: true }),
    ],
  );
}
