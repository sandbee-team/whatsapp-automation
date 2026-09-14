import { randomUUID } from 'node:crypto';
import { createPool } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { getKeys, setKeys } from './pg-repo.js';
import type { SealedBlob } from '@wp/server-kit/crypto';

/**
 * pg-repo-key-type-validation.integration.test.ts (P07 Unit U4, split out of
 * `pg-repo-save-creds.integration.test.ts` to stay under the repo's
 * `max-lines` guard) - non-durable key types are rejected by
 * `classifyAuthKeyType()` validation BEFORE any SQL executes, so no rows are
 * seeded here at all: the random ids below never exist in the database, and
 * the assertions still reject on the validation layer.
 */

let pool: ReturnType<typeof createPool>;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
});

afterAll(async () => {
  await pool.end();
});

function makeBlob(tag: string): SealedBlob {
  return {
    ciphertext: Buffer.from(`ciphertext-${tag}`),
    iv: Buffer.from(`iv-${tag}------`).subarray(0, 12),
    auth_tag: Buffer.from(`authtag-${tag}-`).subarray(0, 16),
    dek_wrapped: Buffer.from(`dek-wrapped-${tag}`),
    dek_iv: Buffer.from(`dek-iv-${tag}--`).subarray(0, 12),
    dek_tag: Buffer.from(`dek-tag-${tag}--`).subarray(0, 16),
    kek_id: 'kek-test-1',
    enc_version: 1,
  };
}

describe('pg-repo durable key-type validation', () => {
  it('setKeys_and_getKeys_reject_non_durable_key_types_before_touching_sql', async () => {
    const clientId = randomUUID();
    const instanceId = randomUUID();

    await expect(
      setKeys(
        pool,
        { instanceId, clientId, fence: 2n, workerId: 'worker-probe', sessionEpoch: 0 },
        [{ keyType: 'session', keyId: 'k1', blob: makeBlob('bad') }],
      ),
    ).rejects.toThrow();

    await expect(getKeys(pool, { instanceId, clientId }, 'session', ['k1'])).rejects.toThrow();
  });
});
