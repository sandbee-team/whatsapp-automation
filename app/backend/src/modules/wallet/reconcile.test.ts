import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TenantDb, TenantQueryable } from '@wp/db';
import { runOneWalletReconcileSweep, type WalletReconcileDeps } from './reconcile.js';

/**
 * reconcile.test.ts (P18 Unit U8b) - unit-level proofs (no PG): the
 * append-only ledger invariant (static source scan), the cross-tenant query
 * registry coverage for U8a's 7 sections, and the reconciler's own
 * per-client grouping/bounding behaviour against a fake pool + fake
 * tenantDb.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('the reconciler module never updates or deletes a ledger row', () => {
  it('the_reconciler_module_never_updates_or_deletes_a_ledger_row', () => {
    const sources = [
      readRepoFile('app/backend/src/modules/wallet/reconcile.ts'),
      readRepoFile('app/backend/src/modules/wallet/reconcile-checks.ts'),
      readRepoFile('app/backend/src/modules/wallet/rollup.ts'),
      readRepoFile('db/queries/wallet-reconcile.sql'),
      readRepoFile('db/queries/debit-send.sql'),
    ];

    for (const source of sources) {
      expect(source).not.toMatch(/UPDATE\s+wallet_ledger/i);
      expect(source).not.toMatch(/DELETE\s+FROM\s+wallet_ledger/i);
    }
  });
});

describe('every cross-tenant reconcile section is registered', () => {
  it('every_cross_tenant_reconcile_section_is_registered', async () => {
    const registrySource = readRepoFile('scripts/registries/cross-tenant-queries.ts');
    const sqlSource = readRepoFile('db/queries/wallet-reconcile.sql');

    const crossTenantSections = [
      'wallet-reconcile-continuity',
      'wallet-reconcile-missing-debits',
      'wallet-reconcile-orphan-debits',
      'wallet-reconcile-rollup-parity',
      'wallet-reconcile-orphan-guards',
      'wallet-rollup-compute',
      'wallet-count-empty-clients',
    ];

    for (const section of crossTenantSections) {
      expect(sqlSource).toContain(`-- name: ${section}`);
      expect(registrySource).toContain(`'db/queries/wallet-reconcile.sql:${section}'`);
    }
  });
});

interface FakeRow {
  client_id: string;
  kind: string;
  detail: Record<string, unknown>;
  amount_minor: number | null;
}

function makeFakePool(continuityRows: FakeRow[]) {
  return {
    query: async <T extends Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> => {
      if (sql.includes('wp_wallet_check_continuity')) {
        return { rows: continuityRows as unknown as T[] };
      }
      // Every other check/gauge returns zero rows for this test.
      if (sql.includes('wp_wallet_count_empty_clients')) {
        return { rows: [{ clients_empty: 0 }] as unknown as T[] };
      }
      return { rows: [] };
    },
  };
}

function makeFakeTenantDb(withTenantCalls: string[], findingInserts: string[]): TenantDb {
  return {
    withTenant: async <T>(
      clientId: string,
      fn: (tx: TenantQueryable) => Promise<T>,
    ): Promise<T> => {
      withTenantCalls.push(clientId);
      const tx: TenantQueryable = {
        query: async <U extends Record<string, unknown>>(
          sql: string,
        ): Promise<{ rows: U[]; rowCount: number | null }> => {
          if (sql.includes('INSERT INTO wallet_reconcile_findings')) {
            findingInserts.push(clientId);
            return { rows: [{ id: 'finding-id' }] as unknown as U[], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
      };
      return fn(tx);
    },
  };
}

describe('findings are grouped per client and bounded', () => {
  it('findings_are_grouped_per_client_and_bounded', async () => {
    const clientA = 'client-a';
    const clientB = 'client-b';
    const clientC = 'client-c';

    const continuityRows: FakeRow[] = [
      { client_id: clientA, kind: 'continuity_break', detail: { seq: 1 }, amount_minor: 5 },
      { client_id: clientA, kind: 'balance_mismatch', detail: { seq: 2 }, amount_minor: -10 },
      { client_id: clientB, kind: 'continuity_break', detail: { seq: 1 }, amount_minor: 3 },
      { client_id: clientB, kind: 'balance_mismatch', detail: { seq: 2 }, amount_minor: -7 },
      { client_id: clientC, kind: 'continuity_break', detail: { seq: 1 }, amount_minor: 1 },
      { client_id: clientC, kind: 'balance_mismatch', detail: { seq: 2 }, amount_minor: -2 },
    ];

    const withTenantCalls: string[] = [];
    const findingInserts: string[] = [];
    const pool = makeFakePool(continuityRows);
    const tenantDb = makeFakeTenantDb(withTenantCalls, findingInserts);

    const drifts: number[] = [];
    const deps: WalletReconcileDeps = {
      pool,
      tenantDb,
      metrics: {
        setDrift: (minor) => drifts.push(minor),
        setClientsEmpty: () => undefined,
        incDebit: () => undefined,
      },
      now: () => new Date('2026-09-03T12:00:00.000Z'),
    };

    const outcome = await runOneWalletReconcileSweep(deps);

    expect(withTenantCalls).toHaveLength(6);
    expect(findingInserts).toHaveLength(6);
    expect(outcome.findings.continuity).toBe(6);
    // |−10| + |−7| + |−2| over the balance_mismatch rows only.
    expect(drifts).toEqual([19]);
  });
});
