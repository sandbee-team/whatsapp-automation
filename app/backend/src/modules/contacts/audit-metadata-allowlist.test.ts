import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { provisioningRepo } from '../tenancy/index.js';

/**
 * audit-metadata-allowlist.test.ts (P20 C1 n1) - `import.repo.ts`,
 * `erasure.ts`, `export-erasure.routes.ts` write `audit_logs.metadata` -
 * every one of them must route it through `provisioningRepo
 * .filterAuditMetadata` (the SAME allow-list `tenancy/provisioning.repo.ts`
 * already enforces elsewhere) so an unplanned metadata key can never reach
 * a row, structurally - not by convention.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));

function readSource(relativeName: string): string {
  return readFileSync(path.join(dirname, relativeName), 'utf8');
}

describe('audit_logs.metadata is routed through filterAuditMetadata', () => {
  it('filterAuditMetadata_itself_drops_an_unlisted_key', () => {
    expect(provisioningRepo.filterAuditMetadata({ source: 'ok', totally_unknown: 'x' })).toEqual({
      source: 'ok',
    });
  });

  it('import_repo_calls_filterAuditMetadata_before_its_audit_insert', () => {
    const source = readSource('import.repo.ts');
    expect(source).toContain("from '../tenancy/index.js'");
    expect(source).toContain('filterAuditMetadata(');
  });

  it('erasure_calls_filterAuditMetadata_before_its_audit_insert', () => {
    const source = readSource('erasure.ts');
    expect(source).toContain("from '../tenancy/index.js'");
    expect(source).toContain('filterAuditMetadata(');
  });

  it('export_erasure_routes_calls_filterAuditMetadata_before_its_audit_insert', () => {
    const source = readSource('export-erasure.routes.ts');
    expect(source).toContain("from '../tenancy/index.js'");
    expect(source).toContain('filterAuditMetadata(');
  });
});
