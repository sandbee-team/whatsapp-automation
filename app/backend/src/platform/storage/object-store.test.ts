import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSafeKeyShape,
  assertTenantKey,
  createFsObjectStore,
  ForeignObjectKeyError,
  ObjectNotFoundError,
  ObjectTooLargeError,
} from './object-store.js';
import type { ObjectStore } from './object-store.js';

/**
 * object-store.test.ts (P20 Unit U3, step 5) - the fs driver's unit tests,
 * run against a real `mkdtemp` scratch directory (fast, no mocked fs).
 */

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_CLIENT_ID = '22222222-2222-2222-2222-222222222222';

let rootDir: string;
let store: ObjectStore;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), 'wp-object-store-'));
  store = createFsObjectStore({ rootDir });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

function bodyOf(text: string): Readable {
  return Readable.from([Buffer.from(text)]);
}

describe('createFsObjectStore', () => {
  it('the_key_is_built_only_by_put_and_has_the_canonical_shape', async () => {
    const result = await store.put({
      clientId: CLIENT_ID,
      kind: 'imports',
      body: bodyOf('a,b,c\n1,2,3\n'),
      contentType: 'text/csv',
      maxBytes: 1024,
      now: new Date('2026-09-05T10:00:00.000Z'),
      id: 'fixed-id',
    });

    expect(result.key).toBe(`clients/${CLIENT_ID}/imports/2026/09/fixed-id.csv`);
  });

  it('a_body_over_the_cap_is_rejected_and_leaves_no_partial_object', async () => {
    const twoKb = 'x'.repeat(2048);

    await expect(
      store.put({
        clientId: CLIENT_ID,
        kind: 'imports',
        body: bodyOf(twoKb),
        contentType: 'text/csv',
        maxBytes: 1024,
        now: new Date('2026-09-05T10:00:00.000Z'),
        id: 'too-big',
      }),
    ).rejects.toThrow(ObjectTooLargeError);

    async function countFiles(dir: string): Promise<number> {
      let total = 0;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          total += await countFiles(path.join(dir, entry.name));
        } else {
          total += 1;
        }
      }
      return total;
    }

    await expect(countFiles(rootDir)).resolves.toBe(0);
  });

  it('a_source_that_never_ends_past_the_cap_is_still_rejected_deterministically', async () => {
    // Regression for a hang where `pipeline()` awaited the SOURCE's own destroy-completion
    // event to settle; a source that keeps pushing past the cap (and, worse, one whose
    // `destroy()` never emits `close`/`error` - see `createCappedSink`'s doc comment) must
    // not be able to make `put()` hang. `overflow` must win the race on its own.
    const neverEndingOverCap = new Readable({
      read() {
        this.push(Buffer.alloc(256, 0x78));
      },
    });
    neverEndingOverCap.on('error', () => undefined); // consumed by the store; keep Node quiet

    await expect(
      store.put({
        clientId: CLIENT_ID,
        kind: 'imports',
        body: neverEndingOverCap,
        contentType: 'text/csv',
        maxBytes: 1024,
        now: new Date('2026-09-05T10:00:00.000Z'),
        id: 'never-ending',
      }),
    ).rejects.toThrow(ObjectTooLargeError);

    async function countFiles(dir: string): Promise<number> {
      let total = 0;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          total += await countFiles(path.join(dir, entry.name));
        } else {
          total += 1;
        }
      }
      return total;
    }

    await expect(countFiles(rootDir)).resolves.toBe(0);
    neverEndingOverCap.destroy();
  });

  it('round_trip_head_and_idempotent_delete', async () => {
    const { key } = await store.put({
      clientId: CLIENT_ID,
      kind: 'imports',
      body: bodyOf('hello,world\n'),
      contentType: 'text/csv',
      maxBytes: 1024,
      now: new Date('2026-09-05T10:00:00.000Z'),
      id: 'round-trip',
    });

    const head = await store.head(key);
    expect(head).not.toBeNull();
    expect(head?.bytes).toBe(Buffer.byteLength('hello,world\n'));

    const stream = await store.getStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString()).toBe('hello,world\n');

    await store.delete(key);
    expect(await store.head(key)).toBeNull();

    // Idempotent: deleting an already-absent key is not an error.
    await expect(store.delete(key)).resolves.toBeUndefined();
    await expect(store.getStream(key)).rejects.toThrow(ObjectNotFoundError);
  });

  it('a_foreign_or_traversing_key_is_rejected_before_any_io', () => {
    const otherTenantKey = `clients/${OTHER_CLIENT_ID}/imports/2026/09/x.csv`;
    const traversalKey = `clients/${CLIENT_ID}/imports/../../../etc/passwd`;
    const backslashKey = `clients/${CLIENT_ID}\\imports\\x.csv`;
    const leadingSlashKey = `/clients/${CLIENT_ID}/imports/2026/09/x.csv`;

    expect(() => assertTenantKey(otherTenantKey, CLIENT_ID)).toThrow(ForeignObjectKeyError);
    expect(() => assertTenantKey(traversalKey, CLIENT_ID)).toThrow(ForeignObjectKeyError);
    expect(() => assertTenantKey(backslashKey, CLIENT_ID)).toThrow(ForeignObjectKeyError);
    expect(() => assertTenantKey(leadingSlashKey, CLIENT_ID)).toThrow(ForeignObjectKeyError);
  });

  it('assertSafeKeyShape_rejects_bad_shapes_but_the_driver_alone_does_not_reject_a_foreign_tenant_key', async () => {
    // assertSafeKeyShape (m2) checks SHAPE only - traversal, backslash,
    // leading slash, unsafe segment characters - never tenancy.
    const traversalKey = `clients/${CLIENT_ID}/imports/../../../etc/passwd`;
    const backslashKey = `clients/${CLIENT_ID}\\imports\\x.csv`;
    const leadingSlashKey = `/clients/${CLIENT_ID}/imports/2026/09/x.csv`;
    const unsafeSegmentKey = `clients/${CLIENT_ID}/imports/2026/09/x y.csv`;

    expect(() => assertSafeKeyShape(traversalKey)).toThrow(ForeignObjectKeyError);
    expect(() => assertSafeKeyShape(backslashKey)).toThrow(ForeignObjectKeyError);
    expect(() => assertSafeKeyShape(leadingSlashKey)).toThrow(ForeignObjectKeyError);
    expect(() => assertSafeKeyShape(unsafeSegmentKey)).toThrow(ForeignObjectKeyError);

    // A well-formed key belonging to a DIFFERENT tenant has a perfectly
    // safe SHAPE - assertSafeKeyShape must NOT reject it (shape only, never
    // tenancy; the caller is responsible for the tenancy check via
    // assertTenantKey, documented in object-store.ts's module doc).
    const otherTenantObject = await store.put({
      clientId: OTHER_CLIENT_ID,
      kind: 'imports',
      body: bodyOf('a,b,c\n1,2,3\n'),
      contentType: 'text/csv',
      maxBytes: 1024,
      now: new Date('2026-09-05T10:00:00.000Z'),
      id: 'other-tenant-object',
    });
    expect(() => assertSafeKeyShape(otherTenantObject.key)).not.toThrow();

    // The driver ALONE (head, given a well-formed foreign-tenant key) does
    // not reject it either - documenting that the CALLER must call
    // assertTenantKey for tenant isolation.
    await expect(store.head(otherTenantObject.key)).resolves.not.toBeNull();
  });

  it('list_filters_by_prefix_and_age', async () => {
    const old = await store.put({
      clientId: CLIENT_ID,
      kind: 'imports',
      body: bodyOf('old'),
      contentType: 'text/csv',
      maxBytes: 1024,
      now: new Date('2026-01-01T00:00:00.000Z'),
      id: 'old-object',
    });
    const recent = await store.put({
      clientId: CLIENT_ID,
      kind: 'imports',
      body: bodyOf('recent'),
      contentType: 'text/csv',
      maxBytes: 1024,
      now: new Date('2026-09-05T00:00:00.000Z'),
      id: 'recent-object',
    });

    const oldMtime = new Date('2026-01-01T00:00:00.000Z');
    const recentMtime = new Date('2026-09-01T00:00:00.000Z');
    await utimes(path.join(rootDir, ...old.key.split('/')), oldMtime, oldMtime);
    await utimes(path.join(rootDir, ...recent.key.split('/')), recentMtime, recentMtime);

    const cutoff = new Date('2026-06-01T00:00:00.000Z');
    const keys: string[] = [];
    for await (const item of store.list(`clients/${CLIENT_ID}/imports/`, { olderThan: cutoff })) {
      keys.push(item.key);
    }

    expect(keys).toEqual([old.key]);
  });
});
