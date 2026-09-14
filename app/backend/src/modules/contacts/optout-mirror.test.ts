import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * optout-mirror.test.ts (P20 Unit U7, step 8) - the PURE static proof (no
 * DB, no `@wp/server-kit` import chain) that the mirror writer, the
 * reconciler sweep, and the retention purge NEVER write `opt_outs` - the
 * mirror is repaired, the authority is not (design doc S2.5). Reads the
 * source text of every file this unit owns and asserts none of them matches
 * an `INSERT/UPDATE/DELETE ... opt_outs` shape; each sweep file also asserts
 * it is tenant-scoped via `withTenant`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

const WRITES_OPT_OUTS_PATTERN = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+opt_outs\b/i;

async function readSource(relativePath: string): Promise<string> {
  return readFile(path.join(HERE, relativePath), 'utf8');
}

describe('the mirror writer, reconciler, and purge never write opt_outs', () => {
  it('the_mirror_writer_reconciler_and_purge_never_write_opt_outs', async () => {
    const files = [
      'optout-mirror.ts',
      'mirror-reconcile.ts',
      'retention-purge.ts',
      path.join('..', '..', '..', '..', '..', 'db', 'queries', 'reconcile-optout-mirror.sql'),
      path.join('..', '..', '..', '..', '..', 'db', 'queries', 'purge-import-errors.sql'),
    ];

    for (const file of files) {
      const source = await readSource(file);
      expect(source, file).not.toMatch(WRITES_OPT_OUTS_PATTERN);
    }

    const mirrorReconcile = await readSource('mirror-reconcile.ts');
    expect(mirrorReconcile).toContain('withTenant');

    const retentionPurge = await readSource('retention-purge.ts');
    expect(retentionPurge).toContain('withTenant');
  });
});
