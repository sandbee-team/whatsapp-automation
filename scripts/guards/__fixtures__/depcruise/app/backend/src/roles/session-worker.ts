// Fixture: production `src` (outside engine/measure/**) must never import
// the benchmark double under engine/measure/** - a benchmark double
// reachable from production code is a real outage waiting to happen.
// This file deliberately violates src-never-imports-measure.
import { runMiniRamp } from '../engine/measure/ramp-runner.js';

export function start(): void {
  runMiniRamp();
}
