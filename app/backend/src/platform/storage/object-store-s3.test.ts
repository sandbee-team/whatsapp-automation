import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createS3ObjectStore, ObjectTooLargeError } from './object-store.js';
import type { S3ClientPort } from './object-store.js';

/**
 * object-store-s3.test.ts (P20 Unit U3, step 5) - the S3 driver's unit
 * tests, against a fake `S3ClientPort` (no real MinIO - that is the
 * `.integration.test.ts` sibling's job).
 */

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const BUCKET = 'wp-test-bucket';

function bodyOf(text: string): Readable {
  return Readable.from([Buffer.from(text)]);
}

function createFakeClient(overrides: Partial<S3ClientPort> = {}): S3ClientPort {
  return {
    putObject: vi.fn(async (_bucket, _key, stream: Readable) => {
      // Drain the stream (mirrors a real client consuming the body).
      for await (const chunk of stream) {
        void chunk;
      }
      return undefined;
    }),
    getObject: vi.fn(async () => Readable.from([Buffer.from('data')])),
    statObject: vi.fn(async () => ({ size: 4, lastModified: new Date('2026-09-05T00:00:00Z') })),
    removeObject: vi.fn(async () => undefined),
    listObjectsV2: vi.fn(() => Readable.from([])),
    bucketExists: vi.fn(async () => true),
    makeBucket: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('createS3ObjectStore', () => {
  it('the_key_is_built_only_by_put_and_has_the_canonical_shape', async () => {
    const client = createFakeClient();
    const store = createS3ObjectStore({ client, bucket: BUCKET });

    const result = await store.put({
      clientId: CLIENT_ID,
      kind: 'imports',
      body: bodyOf('a,b,c\n'),
      contentType: 'text/csv',
      maxBytes: 1024,
      now: new Date('2026-09-05T10:00:00.000Z'),
      id: 'fixed-id',
    });

    expect(result.key).toBe(`clients/${CLIENT_ID}/imports/2026/09/fixed-id.csv`);
    expect(client.putObject).toHaveBeenCalledWith(
      BUCKET,
      result.key,
      expect.anything(),
      undefined,
      { 'Content-Type': 'text/csv' },
    );
  });

  it('cap_enforced_removes_the_partial_object_and_throws', async () => {
    const client = createFakeClient({
      putObject: vi.fn(async (_bucket, _key, stream: Readable) => {
        return await new Promise((resolve, reject) => {
          stream.on('data', () => undefined);
          stream.on('error', reject);
          stream.on('end', () => resolve(undefined));
        });
      }),
    });
    const store = createS3ObjectStore({ client, bucket: BUCKET });

    await expect(
      store.put({
        clientId: CLIENT_ID,
        kind: 'imports',
        body: bodyOf('x'.repeat(2048)),
        contentType: 'text/csv',
        maxBytes: 1024,
        now: new Date('2026-09-05T10:00:00.000Z'),
        id: 'too-big',
      }),
    ).rejects.toThrow(ObjectTooLargeError);

    expect(client.removeObject).toHaveBeenCalledWith(
      BUCKET,
      `clients/${CLIENT_ID}/imports/2026/09/too-big.csv`,
    );
  });

  it('list_maps_name_size_and_last_modified', async () => {
    const lastModified = new Date('2026-09-01T00:00:00Z');
    const client = createFakeClient({
      listObjectsV2: vi.fn(() =>
        Readable.from([
          { name: `clients/${CLIENT_ID}/imports/2026/09/a.csv`, size: 10, lastModified },
        ]),
      ),
    });
    const store = createS3ObjectStore({ client, bucket: BUCKET });

    const items = [];
    for await (const item of store.list(`clients/${CLIENT_ID}/imports/`)) {
      items.push(item);
    }

    expect(items).toEqual([
      { key: `clients/${CLIENT_ID}/imports/2026/09/a.csv`, bytes: 10, lastModified },
    ]);
  });
});
