import { bindQueryParams, loadQuery, type TenantQueryable } from '@wp/db';
import { seal, type KeyProvider, type SealedBlob } from '@wp/server-kit/crypto';

/**
 * registry.ts (P14 Unit U3, step 3 + step 4's `cancelOptOutJobs` wrapper;
 * P20 Unit U8, step 8 - the injected mirror port) - the hashed opt-out
 * registry's server core: `recordOptOut` (idempotent INSERT via the partial
 * unique index `opt_outs_lookup`), `isOptedOut` (the client-or-instance-scope
 * lookup), `sealPhoneForOptOut` (the production envelope-seal call shape for
 * `opt_outs.phone_enc`), and `cancelOptOutJobs` (the
 * `db/queries/cancel-optout-jobs.sql` wrapper).
 *
 * No DELETE anywhere in this module, on purpose: `opt_outs` carries no
 * DELETE grant for any app role (migration 0036) - restore
 * (`restore.ts`) is the only way back, and it is an UPDATE.
 *
 * `OptOutMirrorPort` (P20 design doc S2.5): `contacts.opt_out_state` is a
 * denormalised MIRROR of this table, written in the SAME transaction as the
 * `opt_outs` insert - never the gate (the gate stays `isOptedOut` above).
 * Structurally, the port is `modules/contacts/optout-mirror.ts#syncOptOutMirror`
 * - injected here rather than imported directly because `modules/pacing` may
 * never import `modules/contacts` (dependency-cruiser rule
 * `pacing-never-imports-contacts`). `RecordOptOutDeps.mirror` is a REQUIRED
 * third parameter so no caller can forget to wire the mirror.
 */

export type OptOutScope = 'client' | 'instance';

export interface OptOutMirrorPort {
  (tx: TenantQueryable, input: { clientId: string; phoneHash: Buffer }): Promise<unknown>;
}

export interface RecordOptOutDeps {
  mirror: OptOutMirrorPort;
}

export interface RecordOptOutInput {
  clientId: string;
  scope: OptOutScope;
  scopeKey: string;
  phoneHash: Buffer;
  phoneEnc: Buffer;
  source: 'inbound_keyword' | 'api' | 'manual' | 'import';
  matchedKeyword?: string | null;
  originInstanceId?: string | null;
}

export interface RecordOptOutResult {
  inserted: boolean;
}

/**
 * Idempotent via `opt_outs_lookup`'s partial unique index
 * `(client_id, scope_key, phone_hash) WHERE restored_at IS NULL`: a repeat
 * opt-out for an already-unrestored `(clientId, scopeKey, phoneHash)` tuple
 * is a no-op (`inserted: false`), never a duplicate row or an error.
 *
 * `deps.mirror` runs INSIDE the same `tx` after the INSERT above,
 * unconditionally (whether or not this call actually inserted a new row) -
 * `syncOptOutMirror` is itself idempotent (P20 design doc S2.5), so a repeat
 * call is a correct no-op rather than something this function needs to
 * branch on.
 */
export async function recordOptOut(
  tx: TenantQueryable,
  input: RecordOptOutInput,
  deps: RecordOptOutDeps,
): Promise<RecordOptOutResult> {
  const result = await tx.query(
    `INSERT INTO opt_outs (id, client_id, scope, scope_key, phone_hash, phone_enc, source, matched_keyword, origin_instance_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)
     -- client_id = $1
     ON CONFLICT (client_id, scope_key, phone_hash) WHERE restored_at IS NULL DO NOTHING
     RETURNING id`,
    [
      input.clientId,
      input.scope,
      input.scopeKey,
      input.phoneHash,
      input.phoneEnc,
      input.source,
      input.matchedKeyword ?? null,
      input.originInstanceId ?? null,
    ],
  );

  await deps.mirror(tx, { clientId: input.clientId, phoneHash: input.phoneHash });

  return { inserted: result.rowCount === 1 };
}

export interface IsOptedOutInput {
  clientId: string;
  instanceId: string;
  phoneHash: Buffer;
}

/**
 * True when an unrestored `opt_outs` row exists at CLIENT scope
 * (`scope_key = clientId`) OR at INSTANCE scope (`scope_key = instanceId`)
 * for `phoneHash` - either scope is sufficient to deny a send.
 */
export async function isOptedOut(tx: TenantQueryable, input: IsOptedOutInput): Promise<boolean> {
  const result = await tx.query(
    `SELECT 1 FROM opt_outs
      WHERE client_id = $1
        AND phone_hash = $2
        AND restored_at IS NULL
        AND ((scope = 'client' AND scope_key = $1) OR (scope = 'instance' AND scope_key = $3))
      LIMIT 1`,
    [input.clientId, input.phoneHash, input.instanceId],
  );
  return result.rowCount === 1;
}

export interface SealPhoneForOptOutInput {
  clientId: string;
  e164OrJid: string;
  recordId: string;
  encVersion: number;
}

/** Base64-framed on-the-wire shape of a `SealedBlob`, for a single-`bytea`-column store - mirrors `provider/baileys/auth-state/codec.ts`'s `EncodedSealedBlob` (plain JSON, no `BufferJSON` - this frames ciphertext, not auth material). */
interface EncodedSealedBlob {
  ciphertext: string;
  iv: string;
  auth_tag: string;
  dek_wrapped: string;
  dek_iv: string;
  dek_tag: string;
  kek_id: string;
  enc_version: number;
}

/** Frames a `SealedBlob` into one opaque `Buffer` for `opt_outs.phone_enc` (a single `bytea` column - migration 0036). */
export function encodeOptOutSealedBlob(blob: SealedBlob): Buffer {
  const encoded: EncodedSealedBlob = {
    ciphertext: blob.ciphertext.toString('base64'),
    iv: blob.iv.toString('base64'),
    auth_tag: blob.auth_tag.toString('base64'),
    dek_wrapped: blob.dek_wrapped.toString('base64'),
    dek_iv: blob.dek_iv.toString('base64'),
    dek_tag: blob.dek_tag.toString('base64'),
    kek_id: blob.kek_id,
    enc_version: blob.enc_version,
  };
  return Buffer.from(JSON.stringify(encoded), 'utf8');
}

/**
 * The production seal call shape for `opt_outs.phone_enc` - purpose
 * `'tenant-secrets'`, table `'opt_outs'`, column `'phone_enc'`. Returns the
 * FRAMED buffer ready to store, not a raw `SealedBlob` (see
 * `encodeOptOutSealedBlob`'s own doc for why one `bytea` column needs
 * framing). Callers that cannot mount `tenant-secrets` in a test (or want
 * deterministic fixture bytes) may write `phone_enc` bytes directly instead
 * of calling this helper - see this module's own integration test for that
 * split.
 */
export function sealPhoneForOptOut(provider: KeyProvider, input: SealPhoneForOptOutInput): Buffer {
  const blob = seal(Buffer.from(input.e164OrJid, 'utf8'), {
    provider,
    purpose: 'tenant-secrets',
    encVersion: input.encVersion,
    tableName: 'opt_outs',
    columnName: 'phone_enc',
    clientId: input.clientId,
    recordId: input.recordId,
  });
  return encodeOptOutSealedBlob(blob);
}

export interface CancelOptOutJobsInput {
  clientId: string;
  phoneHash: Buffer;
  scope: OptOutScope;
  instanceId?: string | null;
}

/**
 * Cancels every currently-QUEUED, non-group job addressed to `phoneHash` -
 * see `db/queries/cancel-optout-jobs.sql`'s own header for the full
 * contract (never `failed`, never touches `attempts`, group jobs excluded).
 * Returns the cancelled job ids (empty on a repeat call - idempotent).
 */
export async function cancelOptOutJobs(
  tx: TenantQueryable,
  input: CancelOptOutJobsInput,
): Promise<string[]> {
  const query = await loadQuery('cancel-optout-jobs');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    phone_hash: input.phoneHash,
    scope: input.scope,
    instance_id: input.instanceId ?? null,
  });
  const result = await tx.query<{ id: string }>(query.text, params);
  return result.rows.map((row) => row.id);
}
