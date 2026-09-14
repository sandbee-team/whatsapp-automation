import { describe, expect, it } from 'vitest';
import { formatPreflightNote } from './run-pg-load-preflight.js';
import type { OrphanAttemptLandmines } from './orphan-attempts-preflight.js';

/**
 * run-pg-load-preflight.test.ts (FIX-P26-E) - pure unit test for
 * `formatPreflightNote`. No `@wp/server-kit` in this file's import chain
 * (only `orphan-attempts-preflight.js`'s types, which import only
 * `@wp/db`'s type), so no stub-wp-server-kit-env import is needed - same
 * reasoning as `run-pg-load-args.test.ts`.
 */

describe('formatPreflightNote', () => {
  it('formats the clean-preflight note with the exact seq and budget values', () => {
    const landmines: OrphanAttemptLandmines = {
      seqLastValue: 42_000,
      seqLastValueRaw: 42_000,
      idBudget: 4000,
      count: 0,
      minJobId: null,
      maxJobId: null,
      distinctClients: 0,
    };
    expect(formatPreflightNote(landmines)).toBe(
      'preflight: 0 orphan send_attempts rows inside the id budget (seq 42000, budget 4000)',
    );
  });
});
