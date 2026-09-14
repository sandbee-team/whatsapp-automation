import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
 * object-store-fs.ts (P20 Unit U3, step 5) - the filesystem `ObjectStore`
 * driver (dev default). Writes to `<key>.part` then `rename`s to the final
 * path so a half-written body is never visible as the final object (matches
 * the S3 driver's "leave no partial object" guarantee via a different
 * mechanism - see `object-store-s3.ts`'s counting Transform + `removeObject`).
 */

/**
 * A counting sink that aborts once `maxBytes` is exceeded, without buffering the whole body.
 *
 * `overflow` resolves the INSTANT the cap is crossed - it does not wait for `pipeline()` to
 * settle. Some sources (e.g. `light-my-request`'s synthetic request stream used by
 * `app.inject()` in tests) already consider themselves "done" by the time `sink.destroy()`
 * runs, so their own `destroy()` becomes a no-op and never emits `close`/`error`; `pipeline()`
 * then waits forever for that source to acknowledge teardown. Racing on `overflow` instead of
 * on `pipeline()`'s promise keeps `put()` deterministic regardless of source behaviour.
 */
function createCappedSink(maxBytes: number): {
  sink: PassThrough;
  bytes: () => number;
  overflow: Promise<ObjectTooLargeError>;
} {
  let bytes = 0;
  const sink = new PassThrough();
  let resolveOverflow: (err: ObjectTooLargeError) => void;
  const overflow = new Promise<ObjectTooLargeError>((resolve) => {
    resolveOverflow = resolve;
  });
  sink.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const err = new ObjectTooLargeError(maxBytes);
      resolveOverflow(err);
      sink.destroy(err);
    }
  });
  return { sink, bytes: () => bytes, overflow };
}

export function createFsObjectStore(opts: { rootDir: string }): ObjectStore {
  const { rootDir } = opts;

  function absolutePath(key: string): string {
    return path.join(rootDir, ...key.split('/'));
  }

  return {
    async put(input: PutObjectInput): Promise<StoredObject> {
      const key = buildImportObjectKey(input);
      const finalPath = absolutePath(key);
      const partPath = `${finalPath}.part`;

      await mkdir(path.dirname(finalPath), { recursive: true });

      const { sink, bytes, overflow } = createCappedSink(input.maxBytes);
      const writeStream = createWriteStream(partPath);

      const pipelineDone = pipeline(input.body, sink, writeStream);
      // Never let a background pipeline rejection (from the same overflow, or from the
      // source failing to unwind cleanly - see createCappedSink's doc comment) surface as
      // an unhandled rejection once we've already settled via `overflow` below.
      pipelineDone.catch(() => undefined);

      try {
        const winner = await Promise.race([pipelineDone.then(() => 'pipeline' as const), overflow]);
        if (winner instanceof ObjectTooLargeError) {
          writeStream.destroy();
          await rm(partPath, { force: true });
          throw winner;
        }
      } catch (err) {
        await rm(partPath, { force: true });
        if (err instanceof ObjectTooLargeError) throw err;
        throw err;
      }

      await rename(partPath, finalPath);
      return { key, bytes: bytes() };
    },

    async getStream(key: string): Promise<Readable> {
      assertSafeKeyShape(key);
      const absolute = absolutePath(key);
      try {
        await stat(absolute);
      } catch {
        throw new ObjectNotFoundError(key);
      }
      return createReadStream(absolute);
    },

    async head(key: string): Promise<ObjectHead | null> {
      assertSafeKeyShape(key);
      try {
        const info = await stat(absolutePath(key));
        return { bytes: info.size, lastModified: info.mtime };
      } catch {
        return null;
      }
    },

    async delete(key: string): Promise<void> {
      assertSafeKeyShape(key);
      await unlink(absolutePath(key)).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
    },

    list(prefix: string, listOpts): AsyncIterable<ObjectListing> {
      return listFs(rootDir, prefix, listOpts);
    },
  };
}

async function* walk(dir: string, base: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      yield* walk(full, relative);
    } else if (!entry.name.endsWith('.part')) {
      yield relative;
    }
  }
}

async function* listFs(
  rootDir: string,
  prefix: string,
  opts?: { olderThan?: Date; limit?: number },
): AsyncIterable<ObjectListing> {
  const scanRoot = path.join(rootDir, ...prefix.split('/').filter(Boolean));
  let count = 0;

  for await (const relative of walk(scanRoot, '')) {
    const key = `${prefix}${prefix.endsWith('/') ? '' : '/'}${relative}`.replace(/\/{2,}/g, '/');
    const info = await stat(path.join(scanRoot, relative));
    if (opts?.olderThan && !(info.mtime < opts.olderThan)) continue;

    yield { key, bytes: info.size, lastModified: info.mtime };
    count += 1;
    if (opts?.limit !== undefined && count >= opts.limit) return;
  }
}
