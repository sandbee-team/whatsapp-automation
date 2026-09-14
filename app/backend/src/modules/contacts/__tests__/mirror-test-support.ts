import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';

/**
 * mirror-test-support.ts (P20 Unit U7, step 8) - shared, non-test fixture
 * machinery for `optout-mirror.integration.test.ts` /
 * `retention-purge.integration.test.ts`. Lives under `__tests__/` so the
 * tenant-scope guard's seed/cleanup exemption covers its raw INSERTs (same
 * convention as `engine/queue/__tests__/queue-send-test-helpers.ts`'s own
 * header) and so vitest's `include` glob never picks it up as its own suite
 * (no `.test.ts` suffix).
 *
 * Deliberately minimal: `contacts`/`opt_outs`/`contact_imports`/
 * `contact_import_errors` all FK only to `clients` (never to
 * `whatsapp_instances` or `users`), so a bare `clients` row is a sufficient
 * tenant seed for every test in this unit - mirrors
 * `db/tests/contacts-schema.test.ts`'s own `insertProbeClient` idiom, not
 * `queue-send-tenant-fixture.ts`'s heavier send-path tenant (that fixture
 * also seeds `whatsapp_instances`/`instance_pacing_state`/wallet rows this
 * unit never touches).
 */

export type TestPool = ReturnType<typeof createPool>;

/** Inserts a minimal probe client and returns its id. */
export async function seedProbeClient(pool: TestPool, label: string): Promise<string> {
  const clientId = randomUUID();
  const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    `Mirror Probe Client ${suffix}`,
    `mirror-probe-${suffix}`,
    'active',
  ]);
  return clientId;
}

export interface SeedContactOptions {
  phoneHash: Buffer;
  optOutState?: 'none' | 'opted_out';
  optedOutAt?: Date | null;
  deletedAt?: Date | null;
}

/** Inserts one minimal `contacts` row directly (bypassing the service layer, which is U4's - this unit tests the mirror writer alone). */
export async function seedContact(
  pool: TestPool,
  clientId: string,
  opts: SeedContactOptions,
): Promise<string> {
  const phoneE164 = `+1555${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 100)}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO contacts (client_id, phone_e164, phone_hash, wa_jid, source, opt_out_state, opted_out_at, deleted_at)
     VALUES ($1, $2, $3, $4, 'manual', $5, $6, $7)
     RETURNING id`,
    [
      clientId,
      phoneE164,
      opts.phoneHash,
      `${phoneE164.replace('+', '')}@s.whatsapp.net`,
      opts.optOutState ?? 'none',
      opts.optedOutAt ?? null,
      opts.deletedAt ?? null,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('seedContact: no row returned');
  return id;
}

/** Inserts one live (unrestored) `opt_outs` row directly, returning its id. */
export async function seedLiveOptOut(
  pool: TestPool,
  clientId: string,
  opts: { scope: 'client' | 'instance'; scopeKey: string; phoneHash: Buffer; createdAt?: Date },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO opt_outs (id, client_id, scope, scope_key, phone_hash, phone_enc, source, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7)`,
    [
      id,
      clientId,
      opts.scope,
      opts.scopeKey,
      opts.phoneHash,
      Buffer.from('probe-phone-enc'),
      opts.createdAt ?? new Date(),
    ],
  );
  return id;
}

/** Reverse-FK-order cleanup for probe clients created by `seedProbeClient`; tolerant of an empty list (no-op). */
export async function cleanupMirrorProbeClients(
  pool: TestPool,
  probeClientIds: string[],
): Promise<void> {
  if (probeClientIds.length === 0) return;
  await pool.query('DELETE FROM contact_import_errors WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM contact_imports WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM contacts WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
}
