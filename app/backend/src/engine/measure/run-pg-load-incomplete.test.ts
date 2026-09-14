import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  toIncompleteOutPath,
  formatDrainTimeoutNote,
  writeIncompleteArtifact,
} from './run-pg-load-incomplete.js';
import { DrainTimeoutError } from './run-pg-load-fleet.js';

/**
 * run-pg-load-incomplete.test.ts (FIX-P26-E) - pure unit tests for the
 * `.INCOMPLETE.json` path/note builders plus a filesystem-only
 * (no DB, no fleet) test of `writeIncompleteArtifact` against a scratch temp
 * directory. `run-pg-load-fleet.js` (for `DrainTimeoutError`) has no
 * `@wp/server-kit` in its import chain (only `@wp/db` types and sibling
 * measure modules - see `run-pg-load-args.test.ts` for the same reasoning),
 * so no stub-wp-server-kit-env import is needed here.
 */

describe('toIncompleteOutPath', () => {
  it('replaces the .json extension with .INCOMPLETE.json', () => {
    expect(toIncompleteOutPath('docs/measurements/2026-09-07-loadmodel.json')).toBe(
      'docs/measurements/2026-09-07-loadmodel.INCOMPLETE.json',
    );
  });
});

describe('toIncompleteOutPath - boundary extensions (C2, real defect fixed)', () => {
  it('appends .INCOMPLETE.json when the out path has no .json extension at all (was: returned UNCHANGED)', () => {
    const result = toIncompleteOutPath('docs/measurements/2026-09-07-loadmodel');
    expect(result).toBe('docs/measurements/2026-09-07-loadmodel.INCOMPLETE.json');
  });

  it('strips only the trailing .json of a .json.json double extension, never collapsing further', () => {
    const result = toIncompleteOutPath('docs/measurements/2026-09-07-loadmodel.json.json');
    expect(result).toBe('docs/measurements/2026-09-07-loadmodel.json.INCOMPLETE.json');
  });

  it('is case-insensitive on the .json suffix (was: .JSON left UNCHANGED, same collision defect)', () => {
    expect(toIncompleteOutPath('x.JSON')).toBe('x.INCOMPLETE.json');
  });

  it('handles the empty-string edge case without throwing', () => {
    expect(toIncompleteOutPath('')).toBe('.INCOMPLETE.json');
  });

  it('every input, matched extension or not, ends in exactly .INCOMPLETE.json - never a bare .json', () => {
    for (const input of ['x.json', 'x', 'x.JSON', 'a.b.json.json', '']) {
      const result = toIncompleteOutPath(input);
      expect(result.endsWith('.INCOMPLETE.json')).toBe(true);
      expect(/(?<!INCOMPLETE)\.json$/.test(result)).toBe(false);
    }
  });
});

describe('formatDrainTimeoutNote', () => {
  it('formats elapsed/timeout/pending with the exact values', () => {
    const err = new DrainTimeoutError({
      elapsedMs: 125_000,
      timeoutMs: 120_000,
      pending: 7,
      pendingSample: [],
    });
    expect(formatDrainTimeoutNote(err)).toBe('drain timeout: 125.0s of 120.0s, 7 pending');
  });
});

describe('writeIncompleteArtifact', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-pg-load-incomplete-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the artifact JSON to the .INCOMPLETE.json path and returns that path', () => {
    const outPath = join(dir, 'sub', '2026-09-07-loadmodel.json');
    const artifact = { drain: { complete: false, pendingAtEnd: 3, pendingSample: [] } };

    const written = writeIncompleteArtifact(outPath, artifact);

    expect(written).toBe(join(dir, 'sub', '2026-09-07-loadmodel.INCOMPLETE.json'));
    const parsed: unknown = JSON.parse(readFileSync(written, 'utf8'));
    expect(parsed).toEqual(artifact);
  });
});
