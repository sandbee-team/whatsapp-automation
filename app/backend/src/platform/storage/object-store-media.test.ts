import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsObjectStore } from './object-store-fs.js';
import { mediaPrefix } from './object-store-keys.js';
import type { ObjectStore } from './object-store-types.js';

/**
 * object-store-media.test.ts (P34 U-upload) - the widened `ObjectKind` /
 * `contentType` union exercised against the fs driver: a `'media'` kind put
 * derives its extension from `contentType` (never hard-coded `.csv`), and
 * `'imports'` keeps its `.csv` extension byte-for-byte (regression guard
 * for the P20 shape).
 */

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';

let rootDir: string;
let store: ObjectStore;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), 'wp-object-store-media-'));
  store = createFsObjectStore({ rootDir });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

function bodyOf(text: string): Readable {
  return Readable.from([Buffer.from(text)]);
}

describe('ObjectKind widened to media', () => {
  it('a_media_put_derives_its_extension_from_the_content_type', async () => {
    const result = await store.put({
      clientId: CLIENT_ID,
      kind: 'media',
      body: bodyOf('\xff\xd8\xff'),
      contentType: 'image/jpeg',
      maxBytes: 1024,
      now: new Date('2026-09-14T10:00:00.000Z'),
      id: 'fixed-media-id',
    });

    expect(result.key).toBe(`clients/${CLIENT_ID}/media/2026/09/fixed-media-id.jpg`);
  });

  it('a_media_put_of_a_pdf_derives_the_pdf_extension', async () => {
    const result = await store.put({
      clientId: CLIENT_ID,
      kind: 'media',
      body: bodyOf('%PDF-1.4'),
      contentType: 'application/pdf',
      maxBytes: 1024,
      now: new Date('2026-09-14T10:00:00.000Z'),
      id: 'fixed-doc-id',
    });

    expect(result.key).toBe(`clients/${CLIENT_ID}/media/2026/09/fixed-doc-id.pdf`);
  });

  it('an_imports_put_keeps_the_unchanged_csv_extension', async () => {
    const result = await store.put({
      clientId: CLIENT_ID,
      kind: 'imports',
      body: bodyOf('a,b,c\n1,2,3\n'),
      contentType: 'text/csv',
      maxBytes: 1024,
      now: new Date('2026-09-14T10:00:00.000Z'),
      id: 'fixed-import-id',
    });

    expect(result.key).toBe(`clients/${CLIENT_ID}/imports/2026/09/fixed-import-id.csv`);
  });

  it('mediaPrefix_matches_the_shape_put_writes_under', () => {
    expect(mediaPrefix(CLIENT_ID)).toBe(`clients/${CLIENT_ID}/media/`);
  });
});
