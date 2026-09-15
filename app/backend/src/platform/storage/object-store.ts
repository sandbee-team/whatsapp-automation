import { Client as MinioClient } from 'minio';
import type { Config } from '../config.js';
import { createFsObjectStore } from './object-store-fs.js';
import { createS3ObjectStore } from './object-store-s3.js';
import type { ObjectStore } from './object-store-types.js';

/**
 * platform/storage/object-store.ts (P20 Unit U3, step 5) - the object-store
 * port's public entrypoint. Two drivers exist behind the `ObjectStore`
 * interface: `fs` (dev default, `object-store-fs.ts`) and `s3` (MinIO in
 * dev, any S3-compatible service in prod, `object-store-s3.ts`) -
 * `createObjectStoreFromConfig` (below) is the only place that picks
 * between them, driven by `config.OBJECT_STORE_DRIVER`.
 *
 * KEY RULE (the phase's binding line): the object key is built ONLY inside
 * `put()`, as `clients/${clientId}/${kind}/${yyyy}/${mm}/${uuid}.csv`
 * (`buildImportObjectKey`, in the leaf module `object-store-keys.ts`). No
 * other method ever constructs a key.
 *
 * TENANCY IS A CALLER RESPONSIBILITY, NOT A DRIVER GUARANTEE (m2 - this
 * corrects an earlier claim in this doc): `getStream`/`head`/`delete`/`list`
 * on BOTH drivers (`object-store-fs.ts`/`object-store-s3.ts`) call only
 * `assertSafeKeyShape` internally - a SHAPE check (no traversal, no
 * backslash, no leading slash, safe segment charset), never a tenancy
 * check. A well-formed key belonging to a DIFFERENT tenant passes the
 * driver's own check untouched (proved by `object-store.test.ts`). Every
 * CALLER that needs tenant isolation (`import.routes.ts`, `import.repo.ts`,
 * `import-runner.ts`, the retention purge) MUST call `assertTenantKey`
 * itself first - that is the ONLY function that also checks the
 * `clients/${clientId}/` prefix (core invariant 4).
 *
 * The public types (`ObjectStore`, `PutObjectInput`, ...) and the key
 * helpers (`assertSafeKeyShape`, `assertTenantKey`, `importsPrefix`,
 * `buildImportObjectKey`) live in their own leaf modules
 * (`object-store-types.ts` / `object-store-keys.ts`) so this file,
 * `object-store-fs.ts` and `object-store-s3.ts` can all depend on them
 * without a circular import (this file also re-exports the two driver
 * factories) - see those files' own headers.
 */

export type {
  ObjectContentType,
  ObjectHead,
  ObjectKind,
  ObjectListing,
  ObjectStore,
  PutObjectInput,
  StoredObject,
} from './object-store-types.js';
export { ObjectNotFoundError, ObjectTooLargeError } from './object-store-types.js';
export {
  assertSafeKeyShape,
  assertTenantKey,
  ForeignObjectKeyError,
  importsPrefix,
  mediaPrefix,
} from './object-store-keys.js';
export { createFsObjectStore } from './object-store-fs.js';
export { createS3ObjectStore } from './object-store-s3.js';
export type { S3ClientPort } from './object-store-s3.js';

/**
 * Picks the `fs` or `s3` driver from config. `Config` is injected (never the
 * `platform/config.ts` singleton read here directly) so callers/tests can
 * construct a store from an arbitrary parsed config.
 */
export function createObjectStoreFromConfig(config: Config): ObjectStore {
  if (config.OBJECT_STORE_DRIVER === 'fs') {
    return createFsObjectStore({ rootDir: config.OBJECT_STORE_FS_ROOT });
  }

  // Fail-closed: config.ts's loadConfig already throws at load time when
  // driver is 's3' without both keys - this is a defensive re-check, never
  // a silent fallback to fs.
  if (!config.S3_ACCESS_KEY || !config.S3_SECRET_KEY) {
    throw new Error('S3_ACCESS_KEY and S3_SECRET_KEY are required when OBJECT_STORE_DRIVER=s3.');
  }

  const client = new MinioClient({
    endPoint: config.S3_ENDPOINT,
    port: config.S3_PORT,
    useSSL: config.S3_USE_SSL,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
    // REQUIRED against real AWS S3, optional against MinIO. Omitting it makes
    // minio sign every request for its default region (us-east-1); AWS then
    // rejects the request outright:
    //   The authorization header is malformed; the region 'us-east-1' is
    //   wrong; expecting 'ap-south-1'
    // The endpoint hostname already NAMES the region (s3.ap-south-1.amazonaws
    // .com) but minio does not parse it out - the signature is computed from
    // this field alone. Proven live 2026-09-15 on the first AWS deployment:
    // every session-worker auth-state write failed this way, and because the
    // failure surfaced inside Baileys' `connection.update` callback the
    // fail-safe handler tore the socket down BEFORE the QR was ever emitted -
    // so the panel showed an empty QR frame with no error anywhere. Left
    // undefined the behaviour is unchanged for MinIO (dev) and for any
    // S3-compatible service that ignores the region.
    ...(config.S3_REGION ? { region: config.S3_REGION } : {}),
  });

  // minio's `Client` satisfies `S3ClientPort` structurally.
  return createS3ObjectStore({ client, bucket: config.S3_BUCKET });
}
