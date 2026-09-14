import type { createPool } from '@wp/db';
import {
  assertNoOrphanAttemptLandmines,
  idBudgetForRun,
  type OrphanAttemptLandmines,
} from './orphan-attempts-preflight.js';

/**
 * run-pg-load-preflight.ts (FIX-P26-E) - wires FIX-D's read-only
 * `orphan-attempts-preflight.ts` into the runnable harness, split out of
 * `run-pg-load.ts` for the 300-line cap (established idiom -
 * `session-worker-discovery-wiring.ts`). Called BEFORE `fleet.start()` -
 * before any row is seeded - so a landmine refuses the run with nothing to
 * clean up. There is deliberately NO `--skip-preflight` escape hatch: the fix
 * for a landmine is deleting it or moving the fixture that left it, never
 * bypassing the check (run log row 26, plan/v1/P26-scale-proof-1k.md).
 */

/** Pure: formats the artifact `notes` entry recording a clean preflight reading. */
export function formatPreflightNote(landmines: OrphanAttemptLandmines): string {
  return (
    `preflight: 0 orphan send_attempts rows inside the id budget ` +
    `(seq ${String(landmines.seqLastValue)}, budget ${String(landmines.idBudget)})`
  );
}

/**
 * Runs the preflight and returns the note to push into the artifact. Throws
 * `OrphanAttemptLandmineError` straight through on a landmine - the caller
 * must not catch it here (no fleet has been stood up yet, so there is
 * nothing to clean up before exiting).
 */
export async function runOrphanPreflight(
  pool: ReturnType<typeof createPool>,
  args: { sends: number; instances: number },
): Promise<string> {
  const idBudget = idBudgetForRun(args);
  const landmines = await assertNoOrphanAttemptLandmines(pool, idBudget);
  return formatPreflightNote(landmines);
}
