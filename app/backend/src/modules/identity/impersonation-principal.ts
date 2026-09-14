import type { FastifyRequest } from 'fastify';
import type { ImpersonationClaims } from './token-epoch.js';

/**
 * impersonation-principal.ts (P28 Unit U3c) - the read-side helpers a route
 * uses to know whether the CURRENT request is running under an impersonation
 * token, and to redact message-body-shaped fields from a response when it
 * is. `route-policy.ts#enforcePolicy` copies the validated `imp` claim onto
 * `req.auth.imp` (same request object `impersonationOf` reads here) - this
 * file never re-verifies a token itself, it only reads what auth-plugin.ts
 * already verified.
 */

const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'payload',
  'body',
  'text',
  'caption',
  'content',
  'quotedText',
  'mediaUrl',
  'rawMessage',
]);

/** The request's `imp` claim, or `undefined` for an ordinary (non-impersonation) session. */
export function impersonationOf(req: FastifyRequest): ImpersonationClaims | undefined {
  return req.auth?.imp;
}

/** True when the request is an impersonation session scoped to `metadata_only` (the default and far more common scope). */
export function isMetadataOnly(req: FastifyRequest): boolean {
  const imp = impersonationOf(req);
  return imp !== undefined && imp.scope === 'metadata_only';
}

/**
 * Deep-strips every key in `REDACTED_KEYS` from `value` (object or array,
 * recursively) - NEVER replaces a stripped value with a placeholder string,
 * the key is removed entirely, so a `metadata_only` response has no trace
 * that a body field ever existed. Primitives and `null`/`undefined` pass
 * through unchanged. A `Date`/other non-plain-object instance is treated as
 * a primitive (returned as-is) - only plain objects and arrays are walked.
 */
export function redactMessageBodies<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactMessageBodies(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (REDACTED_KEYS.has(key)) continue;
      out[key] = redactMessageBodies(v);
    }
    return out as unknown as T;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && value.constructor === Object;
}
