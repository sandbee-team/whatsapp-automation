/**
 * Fixture: wp/key-construction (P00 step 5).
 *
 * BAD: a raw `wp:` Redis key literal built outside platform/redis.
 * GOOD: keys are built via tenantKey()/sysKey() helpers (packages/server-kit
 * platform/redis, arriving in P01) - never a raw string literal.
 */
export const badKeyLiteral = 'wp:tenant:123:queue';
export const badKeyTemplate = `wp:tenant:${'123'}:queue`;

declare function tenantKey(suffix: string): string;

export const goodKey = tenantKey('tenant:123:queue');
