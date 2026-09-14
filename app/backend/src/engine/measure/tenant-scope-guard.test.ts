import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * tenant-scope-guard.test.ts (P26 C2) - a pure source-scan unit test over
 * the fleet-scale tenant-scoped readers named in the C2 brief:
 * `run-chaos-fleet-reads.ts` and `run-pg-load-snapshots.ts`. Every exported
 * reader that takes a `clientIds`/tenant-scoped argument must have
 * `client_id = ANY(` (or an equivalent per-row equality/ANY predicate) in
 * its SQL text - this makes the tenant-isolation intent local and reviewable
 * without a live database; the real cross-tenant interference behaviour is
 * proven separately by the two-tenant integration suites this phase writes.
 *
 * Three readers are DELIBERATELY EXCLUDED: `readStatementsTotal`,
 * `readRelationSizesBytes` and `readWalBytes` in `run-pg-load-snapshots.ts`
 * are documented, cluster/database-wide operator statistics (their own doc
 * comments say so) with no per-tenant row to scope to - they take no
 * `clientIds` argument at all.
 */

const here = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(join(here, relativePath), 'utf8');
}

/** Extracts one exported async function's body (from its signature to the next top-level `export` or EOF) - good enough for a source-scan assertion over this repo's consistent one-function-per-export style. */
function extractExportedFunctionBodies(source: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const regex = /^export async function (\w+)\(/gm;
  const matches = [...source.matchAll(regex)];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    if (!match) continue;
    const name = match[1];
    if (!name) continue;
    const start = match.index ?? 0;
    const end = matches[i + 1]?.index ?? source.length;
    bodies.set(name, source.slice(start, end));
  }
  return bodies;
}

const TENANT_SCOPE_PATTERN = /client_id\s*=\s*ANY\(/;

describe('tenant-scope guard: run-pg-load-snapshots.ts', () => {
  const source = readSource('run-pg-load-snapshots.ts');
  const bodies = extractExportedFunctionBodies(source);

  const tenantScopedReaders = [
    'readPacingConsumed',
    'readTerminalJobCount',
    'readPendingJobCount',
    'readPendingJobSample',
    'readJobStatusHistogram',
  ];

  it('found at least the expected tenant-scoped readers (guard is not vacuous)', () => {
    for (const name of tenantScopedReaders) {
      expect(bodies.has(name)).toBe(true);
    }
  });

  it.each(tenantScopedReaders)('%s SQL contains a client_id = ANY(...) predicate', (name) => {
    const body = bodies.get(name);
    expect(body).toBeDefined();
    expect(TENANT_SCOPE_PATTERN.test(body ?? '')).toBe(true);
  });

  it('the three documented cluster-wide readers take no clientIds argument (exclusion is intentional, not accidental)', () => {
    for (const name of ['readStatementsTotal', 'readRelationSizesBytes', 'readWalBytes']) {
      const body = bodies.get(name);
      expect(body).toBeDefined();
      expect(body ?? '').not.toContain('clientIds');
    }
  });
});

describe('tenant-scope guard: run-chaos-fleet-reads.ts', () => {
  const source = readSource('run-chaos-fleet-reads.ts');
  const bodies = extractExportedFunctionBodies(source);

  const tenantScopedReaders = [
    'jobStatusTally',
    'countSendAttempts',
    'readFence',
    'readLinkStates',
    'readCredVersions',
    'countStillOwnedBy',
  ];

  it('found at least the expected tenant-scoped readers (guard is not vacuous)', () => {
    for (const name of tenantScopedReaders) {
      expect(bodies.has(name)).toBe(true);
    }
  });

  it.each(tenantScopedReaders)('%s SQL contains a client_id = ANY(...) predicate', (name) => {
    const body = bodies.get(name);
    expect(body).toBeDefined();
    expect(TENANT_SCOPE_PATTERN.test(body ?? '')).toBe(true);
  });

  it('readFences is a thin per-id wrapper delegating to the already-verified readFence, not a second SQL path', () => {
    const body = bodies.get('readFences');
    expect(body).toBeDefined();
    expect(body ?? '').toContain('readFence(pool, id, clientIds)');
    expect(body ?? '').not.toMatch(/SELECT/i);
  });
});

/**
 * MINOR e fix (FIX-P26-H, 2026-09-07): `countJobStatuses`/`aggregateJobStatuses`
 * lived outside this guard's original two files and carried NO `client_id`
 * predicate at all - `SELECT status, count(*) FROM message_jobs WHERE id =
 * ANY($1) GROUP BY status`. Extended here rather than left uncovered.
 */
describe('tenant-scope guard: chaos-fleet-workload.ts', () => {
  const source = readSource('../../../test/integration/chaos/chaos-fleet-workload.ts');
  const bodies = extractExportedFunctionBodies(source);

  it.each(['countJobStatuses'])('%s SQL contains a client_id = ANY(...) predicate', (name) => {
    const body = bodies.get(name);
    expect(body).toBeDefined();
    expect(TENANT_SCOPE_PATTERN.test(body ?? '')).toBe(true);
  });
});

describe('tenant-scope guard: rolling-deploy-workload.ts', () => {
  const source = readSource('../../../test/integration/chaos/rolling-deploy-workload.ts');
  const bodies = extractExportedFunctionBodies(source);

  it.each(['aggregateJobStatuses'])('%s SQL contains a client_id = ANY(...) predicate', (name) => {
    const body = bodies.get(name);
    expect(body).toBeDefined();
    expect(TENANT_SCOPE_PATTERN.test(body ?? '')).toBe(true);
  });
});
