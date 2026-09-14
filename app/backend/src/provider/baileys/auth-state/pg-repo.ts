import { bindQueryParams, loadQuery } from '@wp/db';
import type { SealedBlob } from '@wp/server-kit/crypto';

/**
 * pg-repo.ts (P07 Unit U4) - the Postgres repo over `whatsapp_session_
 * credentials`/`whatsapp_session_keys`: `loadCreds`, `saveCreds` (the
 * canonical fence-predicated upsert), `purgeDurable`, and
 * `classifyWriteMiss` live here; `getKeys`/`setKeys` for the three
 * DURABLE_KEY_TYPES live in `pg-repo-keys.ts` (split purely to stay under the
 * repo's `max-lines` guard) and are re-exported below so callers only ever
 * import this one path.
 *
 * SAFETY BOUNDARY (core-invariants + safety-compliance, same class as
 * `lease-state-repo.ts`'s own boundary comment): this module deals ONLY in
 * `SealedBlob` column values and metadata - no crypto (sealing/opening is
 * `codec.ts`'s job, one layer up), no JSON, no `baileys` import. Every fence/
 * tenant predicate lives inside the loaded `.sql` text; no parameter or
 * "admin override" here may bypass one.
 *
 * Zero rows from `saveCreds`/`setKeys`/`purgeDurable` is a NORMAL, reported
 * (never thrown) outcome - core invariant 2 (fail-safe): an unclear
 * conflict is handled by the caller (`classifyWriteMiss` for creds; a
 * `missed: true`/null result for keys/purge), never assumed to be a hard
 * error here.
 *
 * `keyType` is validated with `classifyAuthKeyType(...) === 'durable'`
 * BEFORE any SQL runs (DECIDED FACT 5, enforced in `pg-repo-keys.ts`) - a
 * `whatsapp_session_keys` CHECK violation under load is the exact failure
 * mode this guards against; failing fast in JS is cheaper and clearer than a
 * 23514 from Postgres.
 */

export interface SessionRepoQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface InstanceTenantRef {
  instanceId: string;
  clientId: string;
}

export interface LoadCredsResult {
  blob: SealedBlob;
  credVersion: bigint;
  sessionEpoch: number;
}

interface CredsLoadRow extends Record<string, unknown> {
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  dek_wrapped: Buffer;
  dek_iv: Buffer;
  dek_tag: Buffer;
  kek_id: string;
  enc_version: number;
  cred_version: string | number | bigint;
  session_epoch: number;
}

function rowToBlob(row: CredsLoadRow): SealedBlob {
  return {
    ciphertext: row.ciphertext,
    iv: row.iv,
    auth_tag: row.auth_tag,
    dek_wrapped: row.dek_wrapped,
    dek_iv: row.dek_iv,
    dek_tag: row.dek_tag,
    kek_id: row.kek_id,
    enc_version: row.enc_version,
  };
}

/** Read-only load of the one `whatsapp_session_credentials` row for an instance, or `null`. */
export async function loadCreds(
  db: SessionRepoQueryable,
  ref: InstanceTenantRef,
): Promise<LoadCredsResult | null> {
  const query = await loadQuery('session-creds-load');
  const params = bindQueryParams(query, {
    instance_id: ref.instanceId,
    client_id: ref.clientId,
  });
  const result = await db.query<CredsLoadRow>(query.text, params);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    blob: rowToBlob(row),
    credVersion: BigInt(row.cred_version),
    sessionEpoch: row.session_epoch,
  };
}

export interface SaveCredsInput {
  instanceId: string;
  clientId: string;
  blob: SealedBlob;
  sessionEpoch: number;
  expectedVersion: bigint | number;
  fence: bigint | number;
  workerId: string;
}

export interface SaveCredsResult {
  credVersion: bigint;
}

interface CredsUpsertRow extends Record<string, unknown> {
  cred_version: string | number | bigint;
}

/**
 * Canonical fence-predicated upsert. Returns `null` on zero rows (ambiguous
 * miss - see this module's header and `classifyWriteMiss` below), never
 * throws for that case.
 */
export async function saveCreds(
  db: SessionRepoQueryable,
  input: SaveCredsInput,
): Promise<SaveCredsResult | null> {
  const query = await loadQuery('session-creds-upsert');
  const params = bindQueryParams(query, {
    instance_id: input.instanceId,
    client_id: input.clientId,
    ciphertext: input.blob.ciphertext,
    iv: input.blob.iv,
    auth_tag: input.blob.auth_tag,
    dek_wrapped: input.blob.dek_wrapped,
    dek_iv: input.blob.dek_iv,
    dek_tag: input.blob.dek_tag,
    kek_id: input.blob.kek_id,
    enc_version: input.blob.enc_version,
    session_epoch: input.sessionEpoch,
    expected_version: input.expectedVersion.toString(),
    fence: input.fence.toString(),
    worker_id: input.workerId,
  });
  const result = await db.query<CredsUpsertRow>(query.text, params);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { credVersion: BigInt(row.cred_version) };
}

export interface ClassifyWriteMissInput {
  instanceId: string;
  clientId: string;
  expectedVersion: bigint | number;
  fence: bigint | number;
  workerId: string;
  /**
   * The caller's own `identity.sessionEpoch` - compared against the CURRENT
   * `whatsapp_instances.session_epoch` to detect 'epoch_conflict' (FIX-A
   * CRITICAL-1(c)). Optional only for callers that have no epoch concept of
   * their own (durable/signal `setKeys` re-reads pass `undefined` and get
   * `fence_conflict`/`version_conflict` classification exactly as before -
   * `setKeys` has no per-instance epoch of its own to compare).
   */
  sessionEpoch?: number;
}

export type WriteMissClass = 'version_conflict' | 'fence_conflict' | 'epoch_conflict';

interface ClassifyMissRow extends Record<string, unknown> {
  cred_version: string | number | bigint | null;
  current_fence: string | number | bigint | null;
  owner_worker_id: string | null;
  instance_session_epoch: number | null;
}

/**
 * Re-reads `instance_lease_state.current_fence`/`owner_worker_id`,
 * `whatsapp_instances.session_epoch`, and `cred_version` after a zero-row
 * `saveCreds` to decide which of three MUTUALLY EXCLUSIVE outcomes happened,
 * in this fixed priority order (FIX-A CRITICAL-1(c) extends the original
 * two-class fence-mismatch-wins rule to three classes):
 *
 *   1. 'fence_conflict' - the lease's current fence no longer equals the
 *      fence this caller used, OR no lease row exists at all, OR the lease's
 *      `owner_worker_id` no longer equals this caller's `workerId`
 *      (CRITICAL-2: a released/stolen lease fails here even when the
 *      numeric fence still happens to match). WINS regardless of what
 *      `cred_version`/`session_epoch` show.
 *   2. 'epoch_conflict' - fence AND owner both still check out, but the
 *      caller's `sessionEpoch` no longer equals the instance's CURRENT
 *      `session_epoch` (a purge bumped it since this caller was built).
 *   3. 'version_conflict' - fence, owner, and epoch all check out; an
 *      ordinary optimistic-concurrency miss - retry with the fresh
 *      `cred_version`.
 */
export async function classifyWriteMiss(
  db: SessionRepoQueryable,
  input: ClassifyWriteMissInput,
): Promise<WriteMissClass> {
  const query = await loadQuery('session-creds-classify-miss');
  const params = bindQueryParams(query, {
    instance_id: input.instanceId,
    client_id: input.clientId,
  });
  const result = await db.query<ClassifyMissRow>(query.text, params);
  const row = result.rows[0];
  const currentFence = row?.current_fence == null ? null : BigInt(row.current_fence);
  const fence = typeof input.fence === 'bigint' ? input.fence : BigInt(input.fence);
  const ownerWorkerId = row?.owner_worker_id ?? null;

  if (currentFence === null || currentFence !== fence || ownerWorkerId !== input.workerId) {
    return 'fence_conflict';
  }

  if (input.sessionEpoch !== undefined) {
    const instanceSessionEpoch = row?.instance_session_epoch ?? null;
    if (instanceSessionEpoch === null || instanceSessionEpoch !== input.sessionEpoch) {
      return 'epoch_conflict';
    }
  }

  return 'version_conflict';
}

export interface PurgeDurableInput {
  instanceId: string;
  clientId: string;
  fence: bigint | number;
  workerId: string;
}

export interface PurgeDurableResult {
  credsDeleted: number;
  keysDeleted: number;
}

interface PurgeRow extends Record<string, unknown> {
  instance_id?: string;
  key_id?: string;
}

/**
 * Fence-predicated DELETE on both durable tables for one instance, run as
 * two statements against `db` (a caller-provided transaction handle owns the
 * atomicity - this function does not open its own transaction). Returns
 * `null` when NEITHER delete removed anything (a total miss - same
 * ambiguous-zero-rows class as `saveCreds`); a partial delete (e.g. creds
 * existed but no keys did) is NOT a miss and reports its real counts.
 */
export async function purgeDurable(
  db: SessionRepoQueryable,
  input: PurgeDurableInput,
): Promise<PurgeDurableResult | null> {
  const credsQuery = await loadQuery('session-purge-durable-creds');
  const credsParams = bindQueryParams(credsQuery, {
    instance_id: input.instanceId,
    client_id: input.clientId,
    fence: input.fence.toString(),
    worker_id: input.workerId,
  });
  const credsResult = await db.query<PurgeRow>(credsQuery.text, credsParams);

  const keysQuery = await loadQuery('session-purge-durable-keys');
  const keysParams = bindQueryParams(keysQuery, {
    instance_id: input.instanceId,
    client_id: input.clientId,
    fence: input.fence.toString(),
    worker_id: input.workerId,
  });
  const keysResult = await db.query<PurgeRow>(keysQuery.text, keysParams);

  const credsDeleted = credsResult.rows.length;
  const keysDeleted = keysResult.rows.length;

  if (credsDeleted === 0 && keysDeleted === 0) {
    return null;
  }
  return { credsDeleted, keysDeleted };
}

export {
  getKeys,
  setKeys,
  type SetKeysCtx,
  type SetKeysWrite,
  type SetKeysResult,
} from './pg-repo-keys.js';
