import './__test-support__/stub-wp-server-kit-env.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REGISTERED_PLATFORM_READS } from './registered-reads.js';

/**
 * platform-read.test.ts (P28 Unit U4, step 6) - the MECHANICAL half of the
 * "admin/backend cannot read across tenants outside `platformRead()`" claim.
 * A source scan, not a behaviour test: behaviour is pinned by
 * `platform-read.integration.test.ts` (audit row in the same transaction,
 * projections carry no PII). This file proves the STRUCTURE that makes the
 * behavioural guarantee unbypassable:
 *
 *  1. Only `platform/db-admin.ts` may construct a pool, and only
 *     `platform/platform-read.ts` may enter the `wp_admin_app` role - so
 *     there is no second code path that could open an unaudited connection.
 *  2. Every exported function in a `*.read.ts` module has a complete
 *     `CROSS_TENANT_QUERIES` entry (non-empty `reason` + `projectedColumns`),
 *     and `registered-reads.ts` mirrors exactly that key set - so a new read
 *     cannot be added without a reviewed registry entry.
 *
 * The registry under `scripts/registries/**` is read as SOURCE TEXT, not
 * imported: `admin/backend/tsconfig.json` is a composite project rooted at
 * `src`, so importing a file outside that root breaks `tsc -b`. Reading it
 * as text is the idiom already used by
 * `app/backend/src/modules/wallet/reconcile.test.ts#every_cross_tenant_reconcile_section_is_registered`
 * for exactly the same reason, and it is strictly stronger for this purpose:
 * it proves the reviewed registry FILE contains the entry, rather than
 * proving some spread-in object did.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

interface SourceFile {
  /** Repo-relative, posix separators - the same shape the registry keys use. */
  repoPath: string;
  content: string;
}

/**
 * The concatenated text of the registry modules that own admin-backend's
 * entries (see the module header for why this is text, not an import).
 */
const REGISTRY_SOURCE = [
  'scripts/registries/cross-tenant-queries.ts',
  'scripts/registries/cross-tenant-queries-p28-admin.ts',
  'scripts/registries/cross-tenant-queries-p28-admin-reads.ts',
  'scripts/registries/cross-tenant-queries-p28-admin-detail.ts',
]
  .map((relativePath) => readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'))
  .join('\n');

/**
 * Extracts one registry entry's literal body from the registry source, so
 * `role`/`reason`/`projectedColumns` can be checked for real content rather
 * than mere presence of the key. Returns `undefined` when the key is absent.
 */
function registryEntryBody(key: string): string | undefined {
  const keyAt = REGISTRY_SOURCE.indexOf(`'${key}': {`);
  if (keyAt < 0) return undefined;
  const closeAt = REGISTRY_SOURCE.indexOf('\n    },', keyAt);
  return REGISTRY_SOURCE.slice(keyAt, closeAt < 0 ? undefined : closeAt);
}

/**
 * Directories excluded from the SERVED-API scan, each for a distinct reason:
 *
 *  - `__test-support__`: test-only plumbing, never reachable from a request.
 *  - `ops`: one-shot operator CLIs (`create-staff-user.ts`) run by a human
 *    with database credentials, NOT part of the served API. They legitimately
 *    build their own single-connection pool and write `staff_users` directly -
 *    that is the whole point of an out-of-band provisioning tool, and it is
 *    exactly the access the RUNBOOK's "psql is not audited" note is honest
 *    about. Including them here would force the invariant to be stated as
 *    "except in these files", which is weaker than scoping the scan to the
 *    request-serving tree and saying so.
 */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set(['__test-support__', 'ops']);

function collectSourceFiles(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    out.push({
      repoPath: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
      content: readFileSync(full, 'utf8'),
    });
  }
  return out;
}

const EXPORTED_FUNCTION_PATTERN = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm;

describe('platform-read source invariants', () => {
  it('a_cross_tenant_read_outside_platform_read_is_impossible', () => {
    const files = collectSourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);

    // (1a) Pool construction lives in exactly one file.
    const poolConstructors = files
      .filter((file) => /createPool\(|new Pool\(/.test(file.content))
      .map((file) => file.repoPath);
    expect(poolConstructors).toEqual(['admin/backend/src/platform/db-admin.ts']);

    // (1b) Entering the BYPASSRLS role lives in exactly one file.
    const roleSetters = files
      .filter((file) => /SET LOCAL ROLE wp_admin_app/.test(file.content))
      .map((file) => file.repoPath);
    expect(roleSetters).toEqual(['admin/backend/src/platform/platform-read.ts']);

    // (2) Every exported reader is a registered, fully-documented read.
    const readFiles = files.filter((file) => file.repoPath.endsWith('.read.ts'));
    expect(readFiles.length).toBeGreaterThan(0);

    const derivedKeys: string[] = [];
    for (const file of readFiles) {
      const symbols = [...file.content.matchAll(EXPORTED_FUNCTION_PATTERN)].map(
        (match) => match[1] ?? '',
      );
      expect(symbols.length, `${file.repoPath} exports no read function`).toBeGreaterThan(0);
      for (const symbol of symbols) {
        const key = `${file.repoPath}:${symbol}`;
        derivedKeys.push(key);
        const entry = registryEntryBody(key);
        expect(entry, `missing CROSS_TENANT_QUERIES entry for ${key}`).toBeDefined();
        expect(entry, `${key} is not registered as wp_admin_app`).toContain("role: 'wp_admin_app'");
        // A real reason, not a placeholder - the registry's own rule is that
        // an entry missing role/reason/projectedColumns is itself a violation.
        expect(entry, `${key} has no reason`).toMatch(/reason:\s*\n?\s*(?:'.{80,}|".{80,})/s);
        expect(entry, `${key} projects no columns`).toMatch(/projectedColumns:\s*\[\s*\n?\s*'/);
      }
    }

    // (3) registered-reads.ts mirrors EXACTLY that key set - so `platformRead`
    // refuses (before connecting) any key the registry never reviewed.
    expect([...REGISTERED_PLATFORM_READS].sort()).toEqual([...new Set(derivedKeys)].sort());
  });
});
