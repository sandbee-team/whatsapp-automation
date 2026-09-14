import { randomUUID } from 'node:crypto';
import type { TenantQueryable } from '@wp/db';
import { provisioningRepo } from '../tenancy/index.js';
import { generateApiKey } from './generate-key.js';
import { hashApiKeySecret } from './hash.js';
import {
  insertApiKey,
  listApiKeys as listApiKeysRepo,
  revokeApiKey as revokeApiKeyRepo,
} from './repo.js';
import type { ApiKeyRow } from './repo.js';

/**
 * service.ts (go-live U4) - `api_keys` business logic: generate + hash +
 * insert + audit (create), list, and revoke (404-shaped for a missing/
 * foreign id, never 403 - tenant isolation, core invariant 4). Every
 * mutation is audited the same way `modules/webhooks`/P28 do
 * (`provisioningRepo.insertAuditLog`, same transaction as the write it
 * describes) - the raw key/secret NEVER enters that payload, a log line, or
 * a metric; only ids ever do (this unit's own dispatch text, proven by
 * `service.test.ts`'s `never_writes_the_raw_key_or_secret_into_the_audit_
 * metadata` and `routes.integration.test.ts`'s
 * `the_raw_key_never_appears_in_the_audit_payload`).
 */

export class ApiKeyNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such API key.');
    this.name = 'ApiKeyNotFoundError';
  }
}

export interface CreateApiKeyServiceInput {
  clientId: string;
  userId: string;
  name: string;
}

export interface CreateApiKeyServiceDeps {
  /** The `api-key-pepper` KEK provider's raw material - injected, never read from config here (see `hash.ts`'s own doc comment). */
  pepper: Buffer;
}

export interface CreateApiKeyResult {
  row: ApiKeyRow;
  /** The full one-time key in the clear - returned ONLY here, never again (same "shown once" pattern as `modules/webhooks`' `secret` field). */
  key: string;
}

/** Generates, hashes, inserts, and audits one new API key. */
export async function createApiKey(
  tx: TenantQueryable,
  input: CreateApiKeyServiceInput,
  deps: CreateApiKeyServiceDeps,
): Promise<CreateApiKeyResult> {
  const generated = generateApiKey();
  const secretHash = hashApiKeySecret(generated.secret, deps.pepper);
  const id = randomUUID();

  const row = await insertApiKey(tx, {
    clientId: input.clientId,
    id,
    name: input.name,
    keyPrefix: generated.keyPrefix,
    secretHash,
    last4: generated.last4,
    createdByUserId: input.userId,
  });

  // Only ids ever reach the audit payload - never `generated.key`/
  // `generated.secret` (see module doc comment). `targetId` already carries
  // the new key's id, so no `metadata` is needed here (and
  // `ALLOWED_AUDIT_METADATA_KEYS`, owned by `modules/tenancy`, is outside
  // this unit's file scope to extend).
  await provisioningRepo.insertAuditLog(tx, {
    clientId: input.clientId,
    actorType: 'user',
    actorUserId: input.userId,
    action: 'api_key.created',
    targetType: 'api_key',
    targetId: id,
  });

  return { row, key: generated.key };
}

/** Tenant-scoped list - never selects/returns `secret_hash` (see `repo.ts#listApiKeys`'s own doc comment). */
export async function listApiKeys(tx: TenantQueryable, clientId: string): Promise<ApiKeyRow[]> {
  return listApiKeysRepo(tx, clientId);
}

export interface RevokeApiKeyServiceInput {
  clientId: string;
  id: string;
}

export interface RevokeApiKeyResult {
  id: string;
  revokedAt: string;
}

/**
 * Revokes one key via a conditional UPDATE (never a bare DELETE - migration
 * 0076 grants no DELETE to any role). A missing/foreign/already-revoked id
 * all map to the SAME `ApiKeyNotFoundError` (404-shaped, never 403 -
 * `repo.ts#revokeApiKey`'s own doc comment on why these are
 * indistinguishable at this layer).
 */
export async function revokeApiKey(
  tx: TenantQueryable,
  input: RevokeApiKeyServiceInput,
): Promise<RevokeApiKeyResult> {
  const result = await revokeApiKeyRepo(tx, input.clientId, input.id);
  if (!result.revoked || !result.revokedAt) {
    throw new ApiKeyNotFoundError();
  }

  await provisioningRepo.insertAuditLog(tx, {
    clientId: input.clientId,
    actorType: 'user',
    action: 'api_key.revoked',
    targetType: 'api_key',
    targetId: input.id,
  });

  return { id: input.id, revokedAt: result.revokedAt };
}
