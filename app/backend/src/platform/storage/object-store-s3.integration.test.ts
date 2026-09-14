import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { Client } from 'minio';
import { beforeAll, describe, expect, it } from 'vitest';
import { createS3ObjectStore, ObjectNotFoundError } from './object-store.js';

/**
 * object-store-s3.integration.test.ts (P20 Unit U3, step 5) - the S3
 * driver's real-infra proof, against the dev MinIO (127.0.0.1:9000, up and
 * healthy - see `infra/compose/docker-compose.dev.yml`). Reads
 * `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` from `.secrets/dev.env` the way
 * `platform/db/db-url.ts` reads `DATABASE_URL` - a small local reader here,
 * never importing that file's internals (test-only helper, never shipped).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');
const DEV_ENV_PATH = path.join(REPO_ROOT, '.secrets', 'dev.env');

function resolveMinioCredentials(): { accessKey: string; secretKey: string } {
  const accessKeyFromEnv = process.env.MINIO_ROOT_USER;
  const secretKeyFromEnv = process.env.MINIO_ROOT_PASSWORD;
  if (accessKeyFromEnv && secretKeyFromEnv) {
    return { accessKey: accessKeyFromEnv, secretKey: secretKeyFromEnv };
  }

  const raw = readFileSync(DEV_ENV_PATH, 'utf8');
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }

  const accessKey = values.MINIO_ROOT_USER;
  const secretKey = values.MINIO_ROOT_PASSWORD;
  if (!accessKey || !secretKey) {
    throw new Error(
      `No MinIO credentials available: set MINIO_ROOT_USER/MINIO_ROOT_PASSWORD, or add them to ${DEV_ENV_PATH}.`,
    );
  }
  return { accessKey, secretKey };
}

const BUCKET = 'wp-test';
const CLIENT_ID = '33333333-3333-3333-3333-333333333333';

describe('createS3ObjectStore against real MinIO', () => {
  let store: ReturnType<typeof createS3ObjectStore>;

  beforeAll(() => {
    const { accessKey, secretKey } = resolveMinioCredentials();
    const client = new Client({
      endPoint: '127.0.0.1',
      port: 9000,
      useSSL: false,
      accessKey,
      secretKey,
    });
    store = createS3ObjectStore({ client, bucket: BUCKET });
  });

  it('put_get_delete_round_trip_against_minio', async () => {
    const body = Readable.from([Buffer.from('a,b,c\n1,2,3\n')]);

    const stored = await store.put({
      clientId: CLIENT_ID,
      kind: 'imports',
      body,
      contentType: 'text/csv',
      maxBytes: 1024,
      now: new Date('2026-09-05T10:00:00.000Z'),
      id: 'minio-round-trip',
    });

    expect(stored.key).toBe(`clients/${CLIENT_ID}/imports/2026/09/minio-round-trip.csv`);

    const head = await store.head(stored.key);
    expect(head?.bytes).toBe(Buffer.byteLength('a,b,c\n1,2,3\n'));

    const stream = await store.getStream(stored.key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString()).toBe('a,b,c\n1,2,3\n');

    await store.delete(stored.key);
    expect(await store.head(stored.key)).toBeNull();
  }, 30_000);

  it('a_missing_key_is_object_not_found', async () => {
    const missingKey = `clients/${CLIENT_ID}/imports/2026/09/does-not-exist.csv`;
    await expect(store.getStream(missingKey)).rejects.toThrow(ObjectNotFoundError);
  }, 30_000);
});
