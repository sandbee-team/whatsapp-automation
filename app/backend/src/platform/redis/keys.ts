/**
 * platform/redis/keys.ts (P04a FIXD) - the one place allowed to build a raw
 * `wp:`-prefixed Redis key literal (the `wp/key-construction` lint rule's
 * `ignores: ['**\/platform/redis/**']` exemption is directory-shaped, so it
 * covers this file but not the flat `platform/redis.ts` sibling - see that
 * file's re-export comment and scripts/guards/eslint-guards.test.ts's
 * `a_raw_wp_key_literal_outside_platform_redis_is_rejected`). Every other
 * caller in the workspace builds keys via `sysKey`/`tenantKey`, never a raw
 * template literal.
 */

/**
 * Builds a system-scoped Redis key: `wp:{env}:{parts joined by ':'}` - for
 * non-tenant keys (rate-limit buckets, the token-epoch cache, TOTP
 * replay/jti markers). Keeps the `wp:` namespace prefix in exactly one
 * place.
 */
export function sysKey(env: string, ...parts: string[]): string {
  return `wp:${env}:${parts.join(':')}`;
}

/**
 * Builds a tenant-scoped Redis key: `wp:{env}:c:{clientId}:{parts joined by
 * ':'}` - the sanctioned way to construct a per-client key (core invariant
 * 4, tenant isolation). No current caller needs this yet; exported for the
 * first one that does.
 */
export function tenantKey(env: string, clientId: string, ...parts: string[]): string {
  return `wp:${env}:c:${clientId}:${parts.join(':')}`;
}
