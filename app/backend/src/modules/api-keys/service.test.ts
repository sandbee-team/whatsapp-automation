import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import { createApiKey, revokeApiKey, ApiKeyNotFoundError } from './service.js';

/**
 * service.test.ts (go-live U4) - unit tests for `service.ts`'s own logic:
 * the audit-payload shape `createApiKey` writes (the raw key/secret must
 * NEVER enter it - only ids, per this unit's own dispatch text) and the
 * 404-shaped (never 403) mapping `revokeApiKey` returns for a missing/
 * foreign id. `tx` is a hand-rolled stub (no real Postgres) - the real SQL
 * itself is exercised by `routes.integration.test.ts`.
 */

const PEPPER = Buffer.alloc(32, 0x07);

function stubTx(rows: Record<string, unknown>[] = []): TenantQueryable {
  return {
    query: vi.fn(async () => ({ rows, rowCount: rows.length })),
  } as unknown as TenantQueryable;
}

describe('createApiKey', () => {
  it('never_writes_the_raw_key_or_secret_into_the_audit_metadata', async () => {
    const clientId = randomUUID();
    const userId = randomUUID();
    const keyId = randomUUID();
    const insertedRow = {
      id: keyId,
      name: 'ci-bot',
      key_prefix: 'wp_live_aaaaaaaaaaaa',
      last4: 'abcd',
      created_at: '2026-09-14T00:00:00.000Z',
      last_used_at: null,
      revoked_at: null,
    };

    const queries: { sql: string; params: unknown[] }[] = [];
    const tx: TenantQueryable = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.startsWith('INSERT INTO api_keys')) {
          return { rows: [insertedRow], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as TenantQueryable;

    const result = await createApiKey(tx, { clientId, userId, name: 'ci-bot' }, { pepper: PEPPER });

    expect(result.key).toMatch(/^wp_live_[0-9a-f]{12}_[0-9a-f]{64}$/);

    const auditCall = queries.find((q) => q.sql.includes('INSERT INTO audit_logs'));
    expect(auditCall).toBeDefined();
    const serializedAuditParams = JSON.stringify(auditCall?.params);
    expect(serializedAuditParams).not.toContain(result.key);
    expect(serializedAuditParams).not.toContain(result.key.split('_').pop());
  });
});

describe('revokeApiKey', () => {
  it('returns_a_404_shaped_error_for_a_foreign_or_absent_id_never_403', async () => {
    const tx = stubTx([]); // UPDATE affected zero rows - foreign/absent/already-revoked, indistinguishable
    await expect(revokeApiKey(tx, { clientId: randomUUID(), id: randomUUID() })).rejects.toThrow(
      ApiKeyNotFoundError,
    );
  });

  it('succeeds_when_the_conditional_update_affects_exactly_one_row', async () => {
    const revokedAt = '2026-09-14T00:00:00.000Z';
    const tx = stubTx([{ revoked_at: revokedAt }]);
    const result = await revokeApiKey(tx, { clientId: randomUUID(), id: randomUUID() });
    expect(result.revokedAt).toBe(new Date(revokedAt).toISOString());
  });
});
