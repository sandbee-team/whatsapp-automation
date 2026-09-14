import { describe, expect, it } from 'vitest';
import {
  checkAllowListExists,
  checkCoverage,
  checkCoverageTablesExist,
  type CatalogTableRow,
  type CoverageRegistry,
} from './coverage.js';

const registry: CoverageRegistry = {
  coverage: { clients: 'id', wallet_ledger: 'client_id' },
  nonTenant: { users: 'identity is global; membership is the tenant edge' },
};

describe('checkCoverage', () => {
  it('reports zero findings for a compliant tenant table, an allow-listed table, and a partition child resolving to its covered parent', () => {
    const rows: CatalogTableRow[] = [
      { tableName: 'clients', parentTable: null, columns: ['id', 'company_name'] },
      { tableName: 'users', parentTable: null, columns: ['id', 'email'] },
      {
        tableName: 'wallet_ledger_y2026m08',
        parentTable: 'wallet_ledger',
        columns: ['client_id', 'seq'],
      },
    ];

    expect(checkCoverage(rows, registry)).toEqual([]);
  });

  it('flags an unregistered table with exactly one finding naming it', () => {
    const rows: CatalogTableRow[] = [
      { tableName: 'demo_bad_table', parentTable: null, columns: ['id', 'client_id'] },
    ];

    const findings = checkCoverage(rows, registry);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.tableName).toBe('demo_bad_table');
    expect(findings[0]?.problem).toContain('demo_bad_table');
    expect(findings[0]?.problem).toContain('not covered and not allow-listed');
  });

  it('flags a coverage entry whose tenant-key column is absent from the row', () => {
    const rows: CatalogTableRow[] = [
      { tableName: 'wallet_ledger', parentTable: null, columns: ['seq', 'amount_minor'] },
    ];

    const findings = checkCoverage(rows, registry);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.problem).toContain('client_id');
  });

  it('flags a table registered in both coverage and non-tenant maps', () => {
    const contradictoryRegistry: CoverageRegistry = {
      coverage: { clients: 'id' },
      nonTenant: { clients: 'oops' },
    };
    const rows: CatalogTableRow[] = [{ tableName: 'clients', parentTable: null, columns: ['id'] }];

    const findings = checkCoverage(rows, contradictoryRegistry);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.problem).toContain('BOTH');
  });

  it('flags a non-tenant allow-list entry with an empty/whitespace reason', () => {
    const emptyReasonRegistry: CoverageRegistry = {
      coverage: {},
      nonTenant: { users: '   ' },
    };
    const rows: CatalogTableRow[] = [{ tableName: 'users', parentTable: null, columns: ['id'] }];

    const findings = checkCoverage(rows, emptyReasonRegistry);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.problem).toContain('empty/whitespace reason');
  });
});

describe('checkAllowListExists', () => {
  it('flags a stale allow-list entry naming a table that does not exist', () => {
    const findings = checkAllowListExists(['clients', 'wallet_ledger', 'users'], {
      users: 'identity is global',
      ghost_table: 'this table was dropped',
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.tableName).toBe('ghost_table');
  });

  it('reports zero findings when every allow-list entry exists', () => {
    const findings = checkAllowListExists(['clients', 'users'], {
      users: 'identity is global',
    });

    expect(findings).toEqual([]);
  });
});

describe('checkCoverageTablesExist', () => {
  it('flags a stale coverage entry naming a table that does not exist', () => {
    const findings = checkCoverageTablesExist(['clients', 'wallet_ledger'], {
      clients: 'id',
      wallet_ledger: 'client_id',
      ghost_table: 'client_id',
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.tableName).toBe('ghost_table');
  });

  it('reports zero findings when every coverage entry exists', () => {
    const findings = checkCoverageTablesExist(['clients', 'wallet_ledger'], {
      clients: 'id',
      wallet_ledger: 'client_id',
    });

    expect(findings).toEqual([]);
  });
});
