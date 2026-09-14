import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { cleanupWaGroups, seedWaGroup } from './__tests__/groups-test-helpers.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFsObjectStore } from '../../platform/storage/object-store-fs.js';
import { seedMediaAsset } from '../media/__tests__/seed-media-asset.js';
import {
  buildGroupSendTestKeyProvider,
  createFakeTransport,
  enqueueVia,
  jobIdForPublicId,
  linkInstance,
  resetMinGap,
  runOneIteration,
} from './__tests__/send-test-helpers.js';

/**
 * send-guards-pricing.integration.test.ts (P24 groups-messaging, Unit U4a,
 * step 6) - mandatory tests 6 (a group send is charged once at the group
 * price key) and 8 (the group recipient hash is the HMAC of the normalised
 * jid). Max-lines split of `send-guards.integration.test.ts` - see that
 * file's own doc.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];
// A real media asset is required for a media job now that dispatch resolves
// `mediaId` against `media_assets` (P34) - an invented `{ mediaUrl }` payload
// makes dispatch DEFER rather than send. Filesystem store, temp dir per file.
let mediaRootDir: string;

beforeAll(async () => {
  mediaRootDir = await mkdtemp(path.join(tmpdir(), 'wp-groups-media-'));
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-send-guards-pricing-test',
  });
  tenantDb = createTenantDb(pool);
  keyProvider = buildGroupSendTestKeyProvider();
});

afterAll(async () => {
  await pool.end();
  await rm(mediaRootDir, { recursive: true, force: true });
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM media_assets WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM content_fingerprint_recipients WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM content_fingerprints WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
  }
  await cleanupWaGroups(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('group send pricing and recipient hash (P24 groups-messaging, U4a)', () => {
  it('a_group_send_is_charged_once_at_the_group_price_key', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await linkInstance(pool, instanceId);
    const group = await seedWaGroup(pool, {
      clientId,
      instanceId,
      sendEnabled: true,
      participantCount: 5,
    });

    const balanceBefore = await pool.query<{ balance_minor: string }>(
      `SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1`,
      [clientId],
    );

    await enqueueVia(tenantDb, keyProvider, clientId, instanceId, group.groupJid);
    const transport = createFakeTransport();
    transport.queueResolve(0, 'wamid.group-charge-1');
    const claimed = await runOneIteration(tenantDb, pool, { clientId, instanceId, transport });
    expect(claimed).toBe(true);

    const ledgerRows = await pool.query<{ price_key: string; count: string }>(
      `SELECT price_key, count(*)::text AS count FROM wallet_ledger
         WHERE client_id = $1 GROUP BY price_key`,
      [clientId],
    );
    expect(ledgerRows.rows).toEqual([{ price_key: 'group_text', count: '1' }]);

    const guardRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM wallet_charge_guards WHERE client_id = $1`,
      [clientId],
    );
    expect(guardRows.rows[0]?.count).toBe('1');

    const balanceAfter = await pool.query<{ balance_minor: string }>(
      `SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1`,
      [clientId],
    );
    expect(balanceAfter.rows[0]?.balance_minor).not.toBe(balanceBefore.rows[0]?.balance_minor);

    // Media payload -> group_media.
    const groupMedia = await seedWaGroup(pool, {
      clientId,
      instanceId,
      sendEnabled: true,
      participantCount: 5,
    });
    const objectStore = createFsObjectStore({ rootDir: mediaRootDir });
    const mediaId = await seedMediaAsset(pool, objectStore, clientId);
    await enqueueVia(tenantDb, keyProvider, clientId, instanceId, groupMedia.groupJid, {
      // The CONTRACT kind ('image'), never the coarse DB value 'media' -
      // `createMessage` maps it to `payload_kind` through `payloadKindFor`
      // itself, and that mapper now rejects anything it does not recognise.
      payload: { kind: 'image', mediaId },
      payloadKind: 'image',
    });
    await resetMinGap(pool, instanceId);
    const transportMedia = createFakeTransport();
    transportMedia.queueResolve(0, 'wamid.group-charge-media');
    const claimedMedia = await runOneIteration(tenantDb, pool, {
      clientId,
      instanceId,
      transport: transportMedia,
      objectStore,
    });
    expect(claimedMedia).toBe(true);
    const mediaLedger = await pool.query<{ price_key: string; count: string }>(
      `SELECT price_key, count(*)::text AS count FROM wallet_ledger
         WHERE client_id = $1 AND price_key = 'group_media' GROUP BY price_key`,
      [clientId],
    );
    expect(mediaLedger.rows).toEqual([{ price_key: 'group_media', count: '1' }]);
    // The job itself must have PERSISTED as media, not merely priced as one -
    // a text-persisted media job also sends down the text transport branch.
    const persistedKinds = await pool.query<{ payload_kind: string; count: string }>(
      `SELECT payload_kind, count(*)::text AS count FROM message_jobs
         WHERE client_id = $1 GROUP BY payload_kind ORDER BY payload_kind::text`,
      [clientId],
    );
    expect(persistedKinds.rows).toEqual([
      { payload_kind: 'media', count: '1' },
      { payload_kind: 'text', count: '1' },
    ]);
  });

  it('group_recipient_hash_is_the_hmac_of_the_normalised_jid', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await linkInstance(pool, instanceId);
    const canonicalJid = '120363111111111111@g.us';
    await seedWaGroup(pool, {
      clientId,
      instanceId,
      groupJid: canonicalJid,
      sendEnabled: true,
      participantCount: 5,
    });

    const deviceSuffixed = await enqueueVia(
      tenantDb,
      keyProvider,
      clientId,
      instanceId,
      `${canonicalJid.replace('@g.us', '')}:5@g.us`,
    );
    const jobIdA = await jobIdForPublicId(pool, clientId, deviceSuffixed.id);
    const rowA = await pool.query<{
      recipient_jid: string;
      recipient_hash: Buffer;
      recipient_e164: string | null;
    }>(`SELECT recipient_jid, recipient_hash, recipient_e164 FROM message_jobs WHERE id = $1`, [
      jobIdA,
    ]);
    const expectedHash = hashRecipient(keyProvider, canonicalJid);
    expect(rowA.rows[0]?.recipient_jid).toBe(canonicalJid);
    expect(rowA.rows[0]?.recipient_hash).toEqual(expectedHash);
    expect(rowA.rows[0]?.recipient_e164).toBeNull();

    const upperServer = await enqueueVia(
      tenantDb,
      keyProvider,
      clientId,
      instanceId,
      `${canonicalJid.replace('@g.us', '')}@G.US`,
    );
    const jobIdB = await jobIdForPublicId(pool, clientId, upperServer.id);
    const rowB = await pool.query<{
      recipient_jid: string;
      recipient_hash: Buffer;
      recipient_e164: string | null;
    }>(`SELECT recipient_jid, recipient_hash, recipient_e164 FROM message_jobs WHERE id = $1`, [
      jobIdB,
    ]);
    expect(rowB.rows[0]?.recipient_jid).toBe(canonicalJid);
    expect(rowB.rows[0]?.recipient_hash).toEqual(expectedHash);
    expect(rowB.rows[0]?.recipient_e164).toBeNull();
  });
});
