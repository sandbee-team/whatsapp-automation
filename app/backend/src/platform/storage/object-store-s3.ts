import { Readable, Transform } from 'node:stream';
import { assertSafeKeyShape, buildImportObjectKey } from './object-store-keys.js';
import { ObjectNotFoundError, ObjectTooLargeError } from './object-store-types.js';
import type {
  ObjectHead,
  ObjectListing,
  ObjectStore,
  PutObjectInput,
  StoredObject,
} from './object-store-types.js';

/**
 * object-store-s3.ts (P20 Unit U3, step 5) - the S3-compatible `ObjectStore`
 * driver (MinIO in dev, any S3-compatible service in prod). `S3ClientPort` is
 * a narrow structural port so this file (and its unit test) never depend on
 * minio's own types directly - minio's real `Client` satisfies it
 * structurally, wired in `object-store.ts#createObjectStoreFromConfig`.
 */
export interface S3ClientPort {
  putObject(
    bucket: string,
    key: string,
    stream: Readable,
    size?: number,
    metaData?: Record<string, string>,
  ): Promise<unknown>;
  getObject(bucket: string, key: string): Promise<Readable>;
  statObject(bucket: string, key: string): Promise<{ size: number; lastModified: Date }>;
  removeObject(bucket: string, key: string): Promise<void>;
  listObjectsV2(
    bucket: string,
    prefix: string,
    recursive: boolean,
  ): AsyncIterable<{ name?: string; size?: number; lastModified?: Date }> | NodeJS.ReadableStream;
  bucketExists(bucket: string): Promise<boolean>;
  makeBucket(bucket: string): Promise<void>;
}

/** A counting Transform that destroys the stream (never buffers past the cap) once `maxBytes` is exceeded. */
function createCappedTransform(maxBytes: number): { transform: Transform; bytes: () => number } {
  let bytes = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new ObjectTooLargeError(maxBytes));
        return;
      }
      callback(null, chunk);
    },
  });
  return { transform, bytes: () => bytes };
}

let bucketEnsured = false;

async function ensureBucket(client: S3ClientPort, bucket: string): Promise<void> {
  if (bucketEnsured) return;
  const exists = await client.bucketExists(bucket);
  if (!exists) {
    await client.makeBucket(bucket);
  }
  bucketEnsured = true;
}

export function createS3ObjectStore(opts: { client: S3ClientPort; bucket: string }): ObjectStore {
  const { client, bucket } = opts;

  return {
    async put(input: PutObjectInput): Promise<StoredObject> {
      await ensureBucket(client, bucket);
      const key = buildImportObjectKey(input);
      const { transform, bytes } = createCappedTransform(input.maxBytes);

      const capped = input.body.pipe(transform);

      try {
        await client.putObject(bucket, key, capped, undefined, {
          'Content-Type': input.contentType,
        });
      } catch (err) {
        await client.removeObject(bucket, key).catch(() => undefined);
        if (err instanceof ObjectTooLargeError) throw err;
        throw err;
      }

      return { key, bytes: bytes() };
    },

    async getStream(key: string): Promise<Readable> {
      assertSafeKeyShape(key);
      try {
        return await client.getObject(bucket, key);
      } catch {
        throw new ObjectNotFoundError(key);
      }
    },

    async head(key: string): Promise<ObjectHead | null> {
      assertSafeKeyShape(key);
      try {
        const info = await client.statObject(bucket, key);
        return { bytes: info.size, lastModified: info.lastModified };
      } catch {
        return null;
      }
    },

    async delete(key: string): Promise<void> {
      assertSafeKeyShape(key);
      await client.removeObject(bucket, key);
    },

    list(prefix: string, listOpts): AsyncIterable<ObjectListing> {
      return listS3(client, bucket, prefix, listOpts);
    },
  };
}

async function* listS3(
  client: S3ClientPort,
  bucket: string,
  prefix: string,
  opts?: { olderThan?: Date; limit?: number },
): AsyncIterable<ObjectListing> {
  let count = 0;
  const stream = client.listObjectsV2(bucket, prefix, true);

  for await (const item of stream as AsyncIterable<{
    name?: string;
    size?: number;
    lastModified?: Date;
  }>) {
    if (item.name === undefined || item.lastModified === undefined) continue;
    if (opts?.olderThan && !(item.lastModified < opts.olderThan)) continue;

    yield { key: item.name, bytes: item.size ?? 0, lastModified: item.lastModified };
    count += 1;
    if (opts?.limit !== undefined && count >= opts.limit) return;
  }
}
