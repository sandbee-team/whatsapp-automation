import { describe, expect, it, vi } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import type { OptOutMirrorPort } from './registry.js';
import { ForbiddenRestoreActorError, OptOutNotFoundError, restoreOptOut } from './restore.js';

/**
 * restore.test.ts (P14 Unit U3, step 5; P20 Unit U8, step 8 - the injected
 * mirror port) - `restoreOptOut` unit tests. `TenantQueryable` is a plain
 * interface (no `@wp/server-kit` config singleton in the import chain), so
 * this file does NOT need the `stub-wp-server-kit-env.js` first-import
 * guard.
 */

const FIXTURE_PHONE_HASH = Buffer.from('fixture-phone-hash');

function makeTx(rowCount = 1): {
  tx: TenantQueryable;
  queries: Array<{ sql: string; params: unknown[] }>;
} {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const tx: TenantQueryable = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (rowCount === 1 && /^\s*UPDATE opt_outs\b/.test(sql)) {
        return { rows: [{ phone_hash: FIXTURE_PHONE_HASH }], rowCount };
      }
      return { rows: [], rowCount };
    }) as TenantQueryable['query'],
  };
  return { tx, queries };
}

function makeRecordingMirror(): { mirror: OptOutMirrorPort; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const mirror: OptOutMirrorPort = async (tx, input) => {
    calls.push([tx, input]);
    return { contactsUpdated: 0 };
  };
  return { mirror, calls };
}

describe('restoreOptOut', () => {
  it('restore_requires_a_user_actor_and_a_typed_reason', async () => {
    const { mirror: noopMirror } = makeRecordingMirror();
    const { tx: apiKeyTx } = makeTx();
    await expect(
      restoreOptOut(
        apiKeyTx,
        {
          clientId: 'client-1',
          optOutId: 'opt-out-1',
          actor: { type: 'api_key' },
          restoreReason: 'customer called support',
        },
        { mirror: noopMirror },
      ),
    ).rejects.toBeInstanceOf(ForbiddenRestoreActorError);

    const { tx: systemTx } = makeTx();
    await expect(
      restoreOptOut(
        systemTx,
        {
          clientId: 'client-1',
          optOutId: 'opt-out-1',
          actor: { type: 'system' },
          restoreReason: 'customer called support',
        },
        { mirror: noopMirror },
      ),
    ).rejects.toBeInstanceOf(ForbiddenRestoreActorError);

    const { tx: noUserIdTx } = makeTx();
    await expect(
      restoreOptOut(
        noUserIdTx,
        {
          clientId: 'client-1',
          optOutId: 'opt-out-1',
          actor: { type: 'user' },
          restoreReason: 'customer called support',
        },
        { mirror: noopMirror },
      ),
    ).rejects.toBeInstanceOf(ForbiddenRestoreActorError);

    const { tx: emptyReasonTx } = makeTx();
    await expect(
      restoreOptOut(
        emptyReasonTx,
        {
          clientId: 'client-1',
          optOutId: 'opt-out-1',
          actor: { type: 'user', userId: 'user-1' },
          restoreReason: '   ',
        },
        { mirror: noopMirror },
      ),
    ).rejects.toThrow();

    const { tx: successTx, queries } = makeTx();
    const { mirror, calls: mirrorCalls } = makeRecordingMirror();
    await restoreOptOut(
      successTx,
      {
        clientId: 'client-1',
        optOutId: 'opt-out-1',
        actor: { type: 'user', userId: 'user-1' },
        restoreReason: 'customer called support',
      },
      { mirror },
    );

    expect(queries.length).toBe(2);
    expect(queries[0]!.sql).toContain('UPDATE opt_outs');
    expect(queries[0]!.sql).toContain('restored_at');
    expect(queries[0]!.params).toEqual([
      'opt-out-1',
      'client-1',
      'user-1',
      'customer called support',
    ]);
    expect(queries[1]!.sql).toContain('INSERT INTO audit_logs');

    // The mirror runs INSIDE the same tx, AFTER the audit INSERT, with the
    // RETURNING phone_hash from the UPDATE.
    expect(mirrorCalls.length).toBe(1);
    expect(mirrorCalls[0]?.[0]).toBe(successTx);
    expect(mirrorCalls[0]?.[1]).toEqual({
      clientId: 'client-1',
      phoneHash: FIXTURE_PHONE_HASH,
    });
  });

  it('minor_11_a_not_found_or_already_restored_row_throws_and_never_writes_an_audit_row', async () => {
    // MINOR 11 FIX (P14 review-fix F2): the UPDATE matches ZERO rows (no
    // such row for this client, or it was already restored) - the audit
    // INSERT must never run for a restore that did not actually happen.
    const { tx: zeroRowTx, queries } = makeTx(0);
    const { mirror, calls: mirrorCalls } = makeRecordingMirror();

    await expect(
      restoreOptOut(
        zeroRowTx,
        {
          clientId: 'client-1',
          optOutId: 'opt-out-missing',
          actor: { type: 'user', userId: 'user-1' },
          restoreReason: 'customer called support',
        },
        { mirror },
      ),
    ).rejects.toBeInstanceOf(OptOutNotFoundError);

    // Exactly the UPDATE ran - no audit_logs INSERT, and no mirror call, for
    // a restore that never actually happened.
    expect(queries.length).toBe(1);
    expect(queries[0]!.sql).toContain('UPDATE opt_outs');
    expect(mirrorCalls.length).toBe(0);
  });
});
