import { randomBytes, randomUUID } from 'node:crypto';
import type { TenantQueryable } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { safeFetch, type SafeFetchOptions } from '../../platform/http/safe-fetch.js';
import { sealWebhookSecret } from './secret-codec.js';

/**
 * service.ts (P15 U5, step 8) - `webhook_endpoints` CRUD business logic.
 * `safe-fetch`'s URL validation runs HERE (configuration time) as well as at
 * every dispatch (dispatcher.ts) - a `safeFetch` HEAD-shaped preflight call
 * with `method: 'HEAD'` is issued at create/patch time purely to force the
 * SSRF-guard's scheme/hostname/DNS-resolution checks to run before ANYTHING
 * is written; the response itself (success or failure beyond the guard) is
 * irrelevant here - only a `SafeFetchError` matters, everything else (a
 * real HTTP error from the tenant's own server) is swallowed, because a
 * receiver that is briefly down must still be configurable.
 */

export const WEBHOOK_SECRET_ENC_VERSION = 1;

export interface WebhookEndpointRow {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
}

export class EndpointNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such webhook endpoint.');
    this.name = 'EndpointNotFoundError';
  }
}

export class EndpointUrlRejectedError extends Error {
  readonly code = 'WEBHOOK_URL_REJECTED';
  constructor(reason: string) {
    super(`Webhook endpoint URL was rejected: ${reason}`);
    this.name = 'EndpointUrlRejectedError';
  }
}

/** MINOR FIX: 256 bits of direct CSPRNG output (never two concatenated UUIDv4s, which waste entropy on fixed version/variant bits) - the canonical shape for HMAC key material (`sign.ts`'s own consumer). */
export function generateSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`;
}

/**
 * Runs the SSRF guard at configuration time. Only a `SafeFetchError` (the
 * guard's own typed rejection, e.g. `address_denied`) is treated as a
 * configuration failure - any OTHER error (a real network/response
 * condition from the tenant's own server, which cannot be reached from here
 * in most environments anyway) never blocks saving a URL the guard itself
 * did not reject; the caller passes an injected `fetchFn` so tests never
 * dial a real network.
 */
export async function validateEndpointUrlAtConfigTime(
  url: string,
  fetchFn: (url: string, options: SafeFetchOptions) => ReturnType<typeof safeFetch>,
): Promise<void> {
  try {
    await fetchFn(url, { method: 'HEAD', totalTimeoutMs: 3000 });
  } catch (err) {
    if (err instanceof Error && err.name === 'SafeFetchError') {
      const code = (err as Error & { code?: string }).code;
      if (
        code === 'address_denied' ||
        code === 'invalid_scheme' ||
        code === 'dns_resolution_failed'
      ) {
        throw new EndpointUrlRejectedError(err.message);
      }
      // Any other SafeFetchError (timeout, response too large, tls_error,
      // network_error, redirect_not_followed) is not an SSRF-shape
      // rejection - the URL itself passed the guard, the receiver just
      // didn't answer cleanly. Never block configuration on that.
    }
  }
}

export interface CreateWebhookEndpointServiceInput {
  clientId: string;
  url: string;
  events: string[];
  keyProvider: KeyProvider;
  fetchFn: (url: string, options: SafeFetchOptions) => ReturnType<typeof safeFetch>;
}

export interface CreateWebhookEndpointResult {
  row: WebhookEndpointRow;
  secret: string;
}

/** Creates one endpoint. The plaintext secret is returned ONLY here - never again (routes.ts is the layer that decides never to log/echo it elsewhere). */
export async function createWebhookEndpoint(
  tx: TenantQueryable,
  input: CreateWebhookEndpointServiceInput,
): Promise<CreateWebhookEndpointResult> {
  await validateEndpointUrlAtConfigTime(input.url, input.fetchFn);

  const id = randomUUID();
  const secret = generateSecret();
  const secretEnc = sealWebhookSecret(input.keyProvider, {
    clientId: input.clientId,
    endpointId: id,
    secret,
    encVersion: WEBHOOK_SECRET_ENC_VERSION,
  });

  const result = await tx.query<{
    id: string;
    url: string;
    events: string[];
    enabled: boolean;
    created_at: string;
    last_success_at: string | null;
    consecutive_failures: number;
    disabled_reason: string | null;
  }>(
    `INSERT INTO webhook_endpoints (id, client_id, url, secret_enc, events, enabled)
     VALUES ($1, $2, $3, $4, $5, true)
     -- client_id = $2
     RETURNING id, url, events, enabled, created_at, last_success_at, consecutive_failures, disabled_reason`,
    [id, input.clientId, input.url, secretEnc, input.events],
  );
  const row = result.rows[0];
  if (!row) throw new Error('createWebhookEndpoint: insert returned no row');

  return {
    row: {
      id: row.id,
      url: row.url,
      events: row.events,
      enabled: row.enabled,
      createdAt: new Date(row.created_at).toISOString(),
      lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
      consecutiveFailures: row.consecutive_failures,
      disabledReason: row.disabled_reason,
    },
    secret,
  };
}

function mapRow(row: {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  created_at: string;
  last_success_at: string | null;
  consecutive_failures: number;
  disabled_reason: string | null;
}): WebhookEndpointRow {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    enabled: row.enabled,
    createdAt: new Date(row.created_at).toISOString(),
    lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
    consecutiveFailures: row.consecutive_failures,
    disabledReason: row.disabled_reason,
  };
}

/**
 * Tenant-scoped list - RLS (`SET LOCAL app.client_id`, `withTenant`) PLUS an
 * explicit `client_id` predicate, belt-and-suspenders (the same discipline
 * every other tenant query in this codebase follows - RLS alone is not
 * trusted as the only isolation mechanism, since some deployment/test
 * connections may hold BYPASSRLS, e.g. the dev/test superuser role this
 * suite's own pool connects as).
 */
export async function listWebhookEndpoints(
  tx: TenantQueryable,
  clientId: string,
): Promise<WebhookEndpointRow[]> {
  const result = await tx.query<{
    id: string;
    url: string;
    events: string[];
    enabled: boolean;
    created_at: string;
    last_success_at: string | null;
    consecutive_failures: number;
    disabled_reason: string | null;
  }>(
    `SELECT id, url, events, enabled, created_at, last_success_at, consecutive_failures, disabled_reason
       FROM webhook_endpoints
      WHERE client_id = $1
      ORDER BY created_at`,
    [clientId],
  );
  return result.rows.map(mapRow);
}

/** Loads one endpoint by id, explicitly scoped by `client_id` (belt-and-suspenders alongside RLS - see `listWebhookEndpoints`'s own doc comment) - returns `undefined` for a foreign/absent id (caller maps to 404, never 403 - tenant isolation, core invariant 4). */
export async function loadWebhookEndpoint(
  tx: TenantQueryable,
  clientId: string,
  id: string,
): Promise<WebhookEndpointRow | undefined> {
  const result = await tx.query<{
    id: string;
    url: string;
    events: string[];
    enabled: boolean;
    created_at: string;
    last_success_at: string | null;
    consecutive_failures: number;
    disabled_reason: string | null;
  }>(
    `SELECT id, url, events, enabled, created_at, last_success_at, consecutive_failures, disabled_reason
       FROM webhook_endpoints
      WHERE id = $1 AND client_id = $2`,
    [id, clientId],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : undefined;
}

export interface PatchWebhookEndpointServiceInput {
  clientId: string;
  id: string;
  url?: string;
  events?: string[];
  enabled?: boolean;
  fetchFn: (url: string, options: SafeFetchOptions) => ReturnType<typeof safeFetch>;
}

/**
 * Patches one endpoint (partial), scoped by `client_id` - see
 * `listWebhookEndpoints`'s own doc comment. Re-validates the URL at
 * configuration time when it changes. Returns `undefined` on a foreign/absent
 * id.
 *
 * BUG FIX (P15 C1 FIX F7 / MAJ-5): a `false -> true` `enabled` transition
 * resets `consecutive_failures` to 0 and clears `disabled_reason` IN THE SAME
 * statement - before this fix, re-enabling a disabled endpoint left
 * `consecutive_failures=20`/`disabled_reason` set, so the very next single
 * terminal failure instantly re-disabled it (the documented RUNBOOK recovery
 * procedure was broken). The reset condition checks the ROW'S OWN prior
 * `enabled` value (Postgres evaluates every `SET` expression against the
 * pre-UPDATE row, so `enabled` on the right-hand side is always the OLD
 * value) AND-ed with the caller's own patch input being `true` - never a
 * bare "whenever enabled ends up true" (a PATCH that leaves `enabled`
 * untouched on an already-enabled row must never zero out a live counter).
 */
export async function patchWebhookEndpoint(
  tx: TenantQueryable,
  input: PatchWebhookEndpointServiceInput,
): Promise<WebhookEndpointRow | undefined> {
  if (input.url !== undefined) {
    await validateEndpointUrlAtConfigTime(input.url, input.fetchFn);
  }

  const result = await tx.query<{
    id: string;
    url: string;
    events: string[];
    enabled: boolean;
    created_at: string;
    last_success_at: string | null;
    consecutive_failures: number;
    disabled_reason: string | null;
  }>(
    `UPDATE webhook_endpoints SET url = coalesce($3, url), events = coalesce($4, events),
       enabled = coalesce($5, enabled),
       consecutive_failures = CASE WHEN $5 = true AND enabled = false THEN 0 ELSE consecutive_failures END,
       disabled_reason = CASE WHEN $5 = true AND enabled = false THEN NULL ELSE disabled_reason END
      WHERE id = $1 AND client_id = $2
      RETURNING id, url, events, enabled, created_at, last_success_at, consecutive_failures, disabled_reason`,
    [input.id, input.clientId, input.url ?? null, input.events ?? null, input.enabled ?? null],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : undefined;
}

/** Deletes one endpoint, scoped by `client_id`. Returns `true` when a row was actually deleted (idempotent - a repeat call on an already-gone id returns `false`, never throws). */
export async function deleteWebhookEndpoint(
  tx: TenantQueryable,
  clientId: string,
  id: string,
): Promise<boolean> {
  const result = await tx.query(`DELETE FROM webhook_endpoints WHERE id = $1 AND client_id = $2`, [
    id,
    clientId,
  ]);
  return result.rowCount === 1;
}
