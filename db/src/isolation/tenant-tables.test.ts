import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TENANT_TABLE_COVERAGE } from './tenant-tables.js';

/**
 * `scripts/check-tenant-scope.ts` cannot statically import
 * `TENANT_TABLE_COVERAGE` (its own `scripts/tsconfig.json` has `rootDir: "."`
 * with no project reference to `db`, and a `db/src` -> `scripts` import in
 * the reverse direction fails the same way under `db/tsconfig.json`'s
 * `rootDir: "src"`), so it keeps a literal mirror of this registry's keys
 * instead. This test reads that file's source text (no cross-project
 * TS import, so `tsc -b` stays clean) and extracts its `TENANT_TABLES`
 * array literal, guarding against the two ever drifting apart.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK_TENANT_SCOPE_PATH = path.resolve(
  HERE,
  '..',
  '..',
  '..',
  'scripts',
  'check-tenant-scope.ts',
);

function extractTenantTables(source: string): string[] {
  const match = /export const TENANT_TABLES: string\[\] = \[([\s\S]*?)\];/.exec(source);
  if (!match?.[1]) {
    throw new Error('could not find TENANT_TABLES array literal in check-tenant-scope.ts');
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1] ?? '');
}

describe('TENANT_TABLES / TENANT_TABLE_COVERAGE sync', () => {
  it('scripts/check-tenant-scope.ts TENANT_TABLES matches TENANT_TABLE_COVERAGE keys exactly, both directions', () => {
    const source = readFileSync(CHECK_TENANT_SCOPE_PATH, 'utf8');
    const scriptTables = extractTenantTables(source).sort();
    const coverageKeys = Object.keys(TENANT_TABLE_COVERAGE).sort();

    expect(scriptTables).toEqual(coverageKeys);
  });
});
