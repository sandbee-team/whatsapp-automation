import { describe, expect, it } from 'vitest';
import {
  scanPlacementNeutrality,
  PLACEMENT_NEUTRALITY_ROOTS,
  BANNED_PLACEMENT_PATH_PREFIXES,
  runCheckPlacementNeutrality,
} from '../check-placement-neutrality.js';

/**
 * check-placement-neutrality.test.ts (P09 Unit U5, step 8, ADR 0018 S6) -
 * IMPORT-GRAPH based, never string-based: the `health_state` SQL literal
 * inside `discovery.ts` (link-liveness filtering only) must NOT trip this
 * guard - only a real module-graph edge into a banned prefix trips it. Same
 * fixture-over-pure-core shape as check-shutdown-purity.test.ts - see that
 * file's deviation note re: `scripts/guards/*.test.ts` vs the phase file's
 * `scripts/__tests__/` guess.
 */

describe('check-placement-neutrality (P09 Unit U5, step 8, ADR 0018 S6)', () => {
  it('the_real_tree_passes_with_a_non_zero_scanned_count', () => {
    const real = runCheckPlacementNeutrality();
    expect(real.violations).toEqual([]);
    expect(real.filesScanned).toBeGreaterThan(0);
  });

  it('discovery_and_shed_cannot_import_health_or_restriction_history', () => {
    const files = [
      {
        path: 'app/backend/src/engine/fleet/discovery.ts',
        content: `import { scoreHealth } from '../../modules/instances/service.js';\nexport function run() { return scoreHealth(); }\n`,
      },
      {
        path: 'app/backend/src/engine/fleet/shed.ts',
        content: `export function shedVictims() {}\n`,
      },
      {
        path: 'app/backend/src/modules/instances/service.ts',
        content: `export function scoreHealth() { return 1; }\n`,
      },
    ];

    const violations = scanPlacementNeutrality(files, PLACEMENT_NEUTRALITY_ROOTS);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.file === 'app/backend/src/modules/instances/service.ts')).toBe(
      true,
    );
  });

  it('a_plain_health_state_sql_literal_in_the_module_source_does_not_trip_it', () => {
    const files = [
      {
        path: 'app/backend/src/engine/fleet/discovery.ts',
        content: `export const q = "SELECT * FROM whatsapp_instances WHERE health_state <> 'logged_out'";\n`,
      },
      {
        path: 'app/backend/src/engine/fleet/shed.ts',
        content: `export function shedVictims() {}\n`,
      },
    ];

    const violations = scanPlacementNeutrality(files, PLACEMENT_NEUTRALITY_ROOTS);
    expect(violations).toEqual([]);
  });

  it('banned_path_prefixes_are_a_single_documented_constant', () => {
    expect(BANNED_PLACEMENT_PATH_PREFIXES.length).toBeGreaterThan(0);
    expect(BANNED_PLACEMENT_PATH_PREFIXES.some((p) => p.includes('instances'))).toBe(true);
  });
});
