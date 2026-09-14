import { bindQueryParams, loadQuery } from '@wp/db';
import { classifyAuthKeyType, DURABLE_KEY_TYPES, type DurableAuthKeyType } from '@wp/domain';
import type { SealedBlob } from '@wp/server-kit/crypto';
import type { InstanceTenantRef, SessionRepoQueryable } from './pg-repo.js';

/**
 * pg-repo-keys.ts (P07 Unit U4) - `whatsapp_session_keys` half of the
 * Postgres repo, split out of `pg-repo.ts` purely to stay under the repo's
 * `max-lines` guard; same SAFETY BOUNDARY as `pg-repo.ts`'s own header
 * (SealedBlob column values only, no crypto, no JSON, no baileys import;
 * every fence/tenant predicate lives inside the loaded `.sql` text). Public
 * API is re-exported from `pg-repo.ts` so callers only ever import one path.
 *
 * `keyType` is validated with `classifyAuthKeyType(...) === 'durable'`
 * BEFORE any SQL runs (DECIDED FACT 5) - a `whatsapp_session_keys` CHECK
 * violation under load is the exact failure mode this guards against;
 * failing fast in JS is cheaper and clearer than a 23514 from Postgres.
 */

export function assertDurableKeyType(keyType: string): asserts keyType is DurableAuthKeyType {
  if (classifyAuthKeyType(keyType) !== 'durable') {
    throw new Error(
      `pg-repo: "${keyType}" is not a durable auth key type (expected one of ${DURABLE_KEY_TYPES.join(', ')})`,
    );
  }
}

interface KeysGetRow extends Record<string, unknown> {
  key_id: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  dek_wrapped: Buffer;
  dek_iv: Buffer;
  dek_tag: Buffer;
  kek_id: string;
  enc_version: number;
}

/** Read-only batched fetch of requested key ids for one (instance, keyType). Missing ids are simply absent from the returned map. */
export async function getKeys(
  db: SessionRepoQueryable,
  ref: InstanceTenantRef,
  keyType: string,
  ids: readonly string[],
): Promise<Map<string, SealedBlob>> {
  assertDurableKeyType(keyType);

  const result = new Map<string, SealedBlob>();
  if (ids.length === 0) {
    return result;
  }

  const query = await loadQuery('session-keys-get');
  const params = bindQueryParams(query, {
    instance_id: ref.instanceId,
    client_id: ref.clientId,
    key_type: keyType,
    key_ids: [...ids],
  });
  const rows = await db.query<KeysGetRow>(query.text, params);
  for (const row of rows.rows) {
    result.set(row.key_id, {
      ciphertext: row.ciphertext,
      iv: row.iv,
      auth_tag: row.auth_tag,
      dek_wrapped: row.dek_wrapped,
      dek_iv: row.dek_iv,
      dek_tag: row.dek_tag,
      kek_id: row.kek_id,
      enc_version: row.enc_version,
    });
  }
  return result;
}

export interface SetKeysCtx {
  instanceId: string;
  clientId: string;
  fence: bigint | number;
  workerId: string;
  /**
   * FIX-B SUGGESTION-7: the caller's own `identity.sessionEpoch`, threaded
   * into `session-keys-upsert.sql`/`session-keys-delete.sql`'s
   * `whatsapp_instances` epoch EXISTS predicate - the same storage-layer
   * epoch enforcement `session-creds-upsert.sql` already has (FIX-A
   * CRITICAL-1(b)). `classifyWriteMiss`'s epoch comparison stays the
   * zero-row disambiguator; this only closes the write-side gap.
   */
  sessionEpoch: number;
}

export interface SetKeysWrite {
  keyType: string;
  keyId: string;
  /** `null` = fence-predicated DELETE. */
  blob: SealedBlob | null;
}

export interface SetKeysResult {
  written: number;
  missed: boolean;
}

interface KeysWriteRow extends Record<string, unknown> {
  key_id: string;
}

/**
 * Batched fence-predicated upsert/delete of durable keys - one statement per
 * write kind (never a per-key loop, same "batch, not loop" class as
 * `lease-state-repo.ts`'s `renewBatch`). `writes` may mix upserts (non-null
 * `blob`) and deletes (`blob: null`); each kind runs as its own single
 * batched statement. `missed: true` when the total rows affected is less
 * than the number of writes requested (a fence/tenant miss on at least one
 * row) - the caller must treat this the same fail-safe way as a
 * `saveCreds` miss: never assume the missing rows succeeded.
 */
export async function setKeys(
  db: SessionRepoQueryable,
  ctx: SetKeysCtx,
  writes: readonly SetKeysWrite[],
): Promise<SetKeysResult> {
  for (const write of writes) {
    assertDurableKeyType(write.keyType);
  }

  if (writes.length === 0) {
    return { written: 0, missed: false };
  }

  const upserts = writes.filter(
    (write): write is SetKeysWrite & { blob: SealedBlob } => write.blob !== null,
  );
  const deletes = writes.filter((write) => write.blob === null);

  let written = 0;

  if (upserts.length > 0) {
    const query = await loadQuery('session-keys-upsert');
    const params = bindQueryParams(query, {
      instance_id: ctx.instanceId,
      client_id: ctx.clientId,
      fence: ctx.fence.toString(),
      worker_id: ctx.workerId,
      session_epoch: ctx.sessionEpoch,
      key_types: upserts.map((w) => w.keyType),
      key_ids: upserts.map((w) => w.keyId),
      ciphertexts: upserts.map((w) => w.blob.ciphertext),
      ivs: upserts.map((w) => w.blob.iv),
      auth_tags: upserts.map((w) => w.blob.auth_tag),
      dek_wrappeds: upserts.map((w) => w.blob.dek_wrapped),
      dek_ivs: upserts.map((w) => w.blob.dek_iv),
      dek_tags: upserts.map((w) => w.blob.dek_tag),
      kek_ids: upserts.map((w) => w.blob.kek_id),
      enc_versions: upserts.map((w) => w.blob.enc_version),
    });
    const result = await db.query<KeysWriteRow>(query.text, params);
    written += result.rows.length;
  }

  if (deletes.length > 0) {
    // A single `setKeys` call is scoped to one instance/fence, but deletes
    // may span more than one keyType - group by keyType since
    // session-keys-delete.sql takes one key_type plus an id list.
    const byKeyType = new Map<string, string[]>();
    for (const del of deletes) {
      const ids = byKeyType.get(del.keyType) ?? [];
      ids.push(del.keyId);
      byKeyType.set(del.keyType, ids);
    }

    for (const [keyType, ids] of byKeyType) {
      const query = await loadQuery('session-keys-delete');
      const params = bindQueryParams(query, {
        instance_id: ctx.instanceId,
        client_id: ctx.clientId,
        fence: ctx.fence.toString(),
        worker_id: ctx.workerId,
        session_epoch: ctx.sessionEpoch,
        key_type: keyType,
        key_ids: ids,
      });
      const result = await db.query<KeysWriteRow>(query.text, params);
      written += result.rows.length;
    }
  }

  return { written, missed: written < writes.length };
}
