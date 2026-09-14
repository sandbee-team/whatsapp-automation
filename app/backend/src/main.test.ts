import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * main.test.ts (P08 U6b, role boot smoke) - a static import-shape check:
 * `main.ts`'s ROLE dispatch text references `'session-worker'` and its
 * entrypoint module `./roles/session-worker.js`. A source-text scan (not an
 * actual boot) is deliberate here - `main.ts` runs a top-level
 * `main().catch(...)` on import (real `process.env`/dynamic-import side
 * effects), so actually importing it in a unit test would either require a
 * real DATABASE_URL/REDIS_URL or hang the process - neither is appropriate
 * for a fast unit-level smoke check. Full role-boot behavior is proven by the
 * integration suites (`session-worker-scan.integration.test.ts`,
 * `roles/api.ts`'s own boot in its integration tests) plus
 * `scripts/check-role-boot.ts`'s tree-wide guard.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_TS_PATH = path.join(HERE, 'main.ts');

describe('main.ts ROLE dispatch (P08 U6b)', () => {
  it('dispatches_session_worker_to_its_own_entrypoint_module', () => {
    const content = readFileSync(MAIN_TS_PATH, 'utf8');

    expect(content).toContain("'session-worker'");
    expect(content).toContain('./roles/session-worker.js');
  });

  it('still_dispatches_migrate_and_falls_back_to_api', () => {
    const content = readFileSync(MAIN_TS_PATH, 'utf8');

    expect(content).toContain("'migrate'");
    expect(content).toContain('./roles/migrate.js');
    expect(content).toContain('./roles/api.js');
  });

  it('dispatches_cron_to_its_own_entrypoint_module', () => {
    const content = readFileSync(MAIN_TS_PATH, 'utf8');

    expect(content).toContain("'cron'");
    expect(content).toContain('./roles/cron.js');
  });
});
