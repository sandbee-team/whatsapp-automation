import { describe, expect, it } from 'vitest';
import {
  scanShutdownPurity,
  SHUTDOWN_PURITY_ROOTS,
  runCheckShutdownPurity,
} from '../check-shutdown-purity.js';

/**
 * check-shutdown-purity.test.ts (P09 Unit U5, step 8, mandatory test 11) -
 * `scanShutdownPurity` is a pure function over an already-read `ModuleFile[]`
 * (repo-relative path + content), so the fixture case drives it with an
 * in-memory graph rather than touching the real filesystem - see
 * `module-graph.ts`'s doc comment for why a hand-rolled walker was chosen
 * over dependency-cruiser here.
 *
 * Deviation from the phase file: tests live in `scripts/guards/*.test.ts`
 * (not `scripts/__tests__/`), matching every other guard test in this repo
 * (`check-tenant-scope.test.ts` et al.) - the phase file's path was a guess.
 */

describe('check-shutdown-purity (P09 Unit U5, step 8)', () => {
  it('logout_is_unreachable_from_the_shutdown_path', () => {
    // Real tree: passes, with a non-zero scanned/visited count (the roots
    // exist and are port-injected by design - see drain.ts/shed.ts).
    const real = runCheckShutdownPurity();
    expect(real.violations).toEqual([]);
    expect(real.filesScanned).toBeGreaterThan(0);

    // Fixture: the drain root gains an import that transitively reaches an
    // unlink()-calling module - must turn red.
    const files = [
      {
        path: 'app/backend/src/engine/fleet/drain.ts',
        content: `import { doCleanup } from './leak.js';\nexport function run() { doCleanup(); }\n`,
      },
      {
        path: 'app/backend/src/engine/fleet/shed.ts',
        content: `export function shedVictims() {}\n`,
      },
      {
        path: 'app/backend/src/engine/fleet/leak.js',
        content: `import { unlink } from 'node:fs';\nexport function doCleanup() { unlink('x', () => {}); }\n`,
      },
    ];

    const violations = scanShutdownPurity(files, SHUTDOWN_PURITY_ROOTS);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.message.includes('unlink('))).toBe(true);
  });

  it('a_root_that_imports_the_baileys_socket_layer_is_flagged', () => {
    const files = [
      {
        path: 'app/backend/src/engine/fleet/drain.ts',
        content: `import { pairAccount } from '../../provider/baileys/adapter.js';\nexport function run() { pairAccount(); }\n`,
      },
      {
        path: 'app/backend/src/engine/fleet/shed.ts',
        content: `export function shedVictims() {}\n`,
      },
      {
        path: 'app/backend/src/provider/baileys/adapter.ts',
        content: `export function pairAccount() {}\n`,
      },
    ];

    const violations = scanShutdownPurity(files, SHUTDOWN_PURITY_ROOTS);
    expect(violations.some((v) => v.file === 'app/backend/src/provider/baileys/adapter.ts')).toBe(
      true,
    );
  });

  it('a_root_that_imports_the_pinned_baileys_package_directly_is_flagged', () => {
    const files = [
      {
        path: 'app/backend/src/engine/fleet/drain.ts',
        content: `import { DisconnectReason } from 'baileys';\nexport function run() { return DisconnectReason; }\n`,
      },
      {
        path: 'app/backend/src/engine/fleet/shed.ts',
        content: `export function shedVictims() {}\n`,
      },
    ];

    const violations = scanShutdownPurity(files, SHUTDOWN_PURITY_ROOTS);
    expect(violations.some((v) => v.message.includes('baileys'))).toBe(true);
  });

  it('a_clean_graph_with_only_port_injected_dependencies_has_zero_violations', () => {
    const files = [
      {
        path: 'app/backend/src/engine/fleet/drain.ts',
        content: `import type { TenantQueryable } from '@wp/db';\nexport function run(tx: TenantQueryable) { return tx; }\n`,
      },
      {
        path: 'app/backend/src/engine/fleet/shed.ts',
        content: `import { metrics } from '@wp/server-kit';\nexport function shedVictims() { return metrics; }\n`,
      },
    ];

    expect(scanShutdownPurity(files, SHUTDOWN_PURITY_ROOTS)).toEqual([]);
  });
});
