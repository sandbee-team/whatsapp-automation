// Fixture: production `src` (outside engine/measure/**) must never import
// scripts/measure/** - the measurement harness must be unreachable from
// production code. This file deliberately violates src-never-imports-scripts-measure.
import { runRamp } from '../../../../scripts/measure/fake-ramp-sessions.js';

export function startWorker(): void {
  runRamp();
}
