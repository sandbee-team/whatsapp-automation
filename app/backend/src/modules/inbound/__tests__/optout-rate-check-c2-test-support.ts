import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';

/**
 * optout-rate-check-c2-test-support.ts (P25 SESSION-PROTOCOL C2 edge-case
 * pass) - shared seed helpers for optout-rate-check.c2.integration.test.ts
 * and its max-lines-cap sibling optout-rate-check.c2b.integration.test.ts.
 * NOT itself a test file (no `.test.ts` suffix), same convention as every
 * other `*-test-support.ts` in this tree.
 */

export type TestPool = ReturnType<typeof createPool>;

export async function seedClient(
  pool: TestPool,
  probeClientIds: string[],
  companyName: string,
): Promise<string> {
  const clientId = randomUUID();
  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    companyName,
    `optout-rate-c2-probe-${clientId}`,
    'active',
  ]);
  probeClientIds.push(clientId);
  return clientId;
}

export async function seedInstance(pool: TestPool, clientId: string): Promise<string> {
  const instanceId = randomUUID();
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, 'optout-rate-c2-probe', 'connected', 0)`,
    [instanceId, clientId],
  );
  return instanceId;
}

export async function seedAckedSends(
  pool: TestPool,
  clientId: string,
  instanceId: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await pool.query(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at, sent_at)
       VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 10, 'sent', now(), now(), now())`,
      [
        clientId,
        instanceId,
        `15550001${String(i).padStart(3, '0')}@s.whatsapp.net`,
        JSON.stringify({ text: 'hello' }),
      ],
    );
  }
}

export async function seedOptOuts(
  pool: TestPool,
  clientId: string,
  count: number,
  options: { restored?: boolean } = {},
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await pool.query(
      `INSERT INTO opt_outs (id, client_id, scope, scope_key, phone_hash, phone_enc, source, restored_at)
       VALUES ($1, $2, 'client', $2, $3, $4, 'manual', $5)`,
      [
        randomUUID(),
        clientId,
        Buffer.from(`hash-c2-${clientId}-${i}`),
        Buffer.from('enc-placeholder'),
        options.restored ? new Date() : null,
      ],
    );
  }
}

export async function cleanupOptoutRateC2Probes(
  pool: TestPool,
  probeClientIds: string[],
): Promise<void> {
  if (probeClientIds.length === 0) return;
  // `notify()` (`db/queries/notify-fanout.sql`) writes a `notifications` row
  // PLUS a per-channel `outbox_events` fan-out row in the SAME statement -
  // this suite's `optout_rate_high` notify() calls leave unpublished
  // outbox_events rows fleet-wide when only `notifications` is cleaned up,
  // poisoning any later-running relay test's whole-table claim/count
  // assertions (same bug class as lesson 2026-09-03 "p17-new-emit-paths-
  // leak-rows-into-whole-table-relay-tests-and-seed-clients").
  await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
}
